package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/metrics"
)

type okVerifier struct{}

func (okVerifier) Verify(_ context.Context, tok string) (access.Identity, error) {
	if tok == "" || tok == "bad" {
		return access.Identity{}, access.ErrTokenInvalid
	}
	return access.Identity{DeviceID: tok}, nil
}

func newServer(t *testing.T, c clock.Clock) (*Hub, *httptest.Server) {
	t.Helper()
	hub := NewHub(Config{
		AllowedOrigins: []string{"https://app.example"}, Clock: c, IPs: clientip.New([]netip.Prefix{}),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	mux := http.NewServeMux()
	router := access.NewRouter(mux, okVerifier{})
	hub.Register(router)
	router.Finalize()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	t.Cleanup(hub.Close)
	return hub, srv
}

func wsURL(srv *httptest.Server, ticket string) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/ws?ticket=" + ticket
}

// dial returns the connection, the handshake status code (0 when there was no response), and the error.
func dial(t *testing.T, url, origin string) (*websocket.Conn, int, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{}
	if origin != "" {
		h.Set("Origin", origin)
	}
	c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h})
	code := 0
	if resp != nil {
		code = resp.StatusCode
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	return c, code, err
}

func TestTicketEndpointRequiresDeviceToken(t *testing.T) {
	_, srv := newServer(t, clock.Real{})
	resp, err := http.Post(srv.URL+"/v1/ws/ticket", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("want 401, got %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/v1/ws/ticket", nil)
	req.Header.Set("Authorization", "Bearer dev-1")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Ticket    string `json:"ticket"`
		ExpiresIn int    `json:"expires_in"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	_ = resp.Body.Close()
	if resp.StatusCode != 201 || body.Ticket == "" || body.ExpiresIn != 30 {
		t.Fatalf("got %d %+v", resp.StatusCode, body)
	}
}

func TestWelcomeAndSingleUseTicket(t *testing.T) {
	hub, srv := newServer(t, clock.Real{})
	tk := hub.IssueTicket("dev-1")
	c, _, err := dial(t, wsURL(srv, tk), "https://app.example")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, msg, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var w Welcome
	if json.Unmarshal(msg, &w) != nil || w.Type != "WELCOME" || w.DeviceID != "dev-1" {
		t.Fatalf("unexpected welcome %s", msg)
	}
	if _, code, err := dial(t, wsURL(srv, tk), "https://app.example"); err == nil || code != 401 {
		t.Fatalf("reused ticket must be rejected, got err=%v resp=%v", err, code)
	}
}

func TestRejectsMissingExpiredTicketAndBadOrigin(t *testing.T) {
	c := clock.NewFake(time.Now())
	hub, srv := newServer(t, c)
	if _, code, err := dial(t, wsURL(srv, ""), ""); err == nil || code != 401 {
		t.Fatalf("missing ticket: %v %v", err, code)
	}
	tk := hub.IssueTicket("dev-1")
	c.Advance(31 * time.Second)
	if _, code, err := dial(t, wsURL(srv, tk), ""); err == nil || code != 401 {
		t.Fatalf("expired ticket: %v %v", err, code)
	}
	tk = hub.IssueTicket("dev-1")
	if _, code, err := dial(t, wsURL(srv, tk), "https://evil.example"); err == nil || code != 403 {
		t.Fatalf("bad origin: %v %v", err, code)
	}
	// Origin is checked before the ticket is consumed, so the ticket still works from an allowed origin.
	if conn, _, err := dial(t, wsURL(srv, tk), "https://APP.example"); err != nil {
		t.Fatalf("allowed origin (case-insensitive) after a rejected attempt: %v", err)
	} else {
		_ = conn.CloseNow()
	}
}

func TestPerDeviceConnectionCap(t *testing.T) {
	hub, srv := newServer(t, clock.Real{})
	var conns []*websocket.Conn
	for i := 0; i < MaxPerDevice; i++ {
		c, _, err := dial(t, wsURL(srv, hub.IssueTicket("dev-1")), "")
		if err != nil {
			t.Fatalf("connection %d: %v", i, err)
		}
		conns = append(conns, c)
	}
	if _, code, err := dial(t, wsURL(srv, hub.IssueTicket("dev-1")), ""); err == nil || code != 429 {
		t.Fatalf("4th connection should be refused with 429: %v %v", err, code)
	}
	_ = conns[0].Close(websocket.StatusNormalClosure, "")
	deadline := time.Now().Add(3 * time.Second)
	for {
		c, _, err := dial(t, wsURL(srv, hub.IssueTicket("dev-1")), "")
		if err == nil {
			_ = c.CloseNow()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("slot was not released after close")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, c := range conns[1:] {
		_ = c.CloseNow()
	}
}

func TestMessageRateLimitClosesConnection(t *testing.T) {
	hub, srv := newServer(t, clock.Real{})
	c, _, err := dial(t, wsURL(srv, hub.IssueTicket("dev-1")), "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, _ = c.Read(ctx) // WELCOME
	for i := 0; i < MessagesPerSec+5; i++ {
		if err := c.Write(ctx, websocket.MessageText, []byte(`{}`)); err != nil {
			break
		}
	}
	// Each message gets an ERROR reply (no handler for it); keep reading until the server closes.
	for err == nil {
		_, _, err = c.Read(ctx)
	}
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("expected policy violation close, got %v", err)
	}
}

func readJSON(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestDispatchSendAndDisconnect(t *testing.T) {
	hub, srv := newServer(t, clock.Real{})
	hub.Handle("PING_TEST", func(_ context.Context, deviceID string, raw json.RawMessage) error {
		if strings.Contains(string(raw), "fail") {
			return &Error{Code: "nope"}
		}
		hub.SendToDevice(deviceID, map[string]string{"type": "PONG_TEST"})
		return nil
	})
	c, _, err := dial(t, wsURL(srv, hub.IssueTicket("dev-1")), "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if readJSON(t, c)["type"] != "WELCOME" {
		t.Fatal("welcome first")
	}
	ctx := context.Background()
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"PING_TEST"}`))
	if m := readJSON(t, c); m["type"] != "PONG_TEST" {
		t.Fatalf("got %v", m)
	}
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"PING_TEST","ref":"r1","x":"fail"}`))
	if m := readJSON(t, c); m["type"] != "ERROR" || m["code"] != "nope" || m["ref"] != "r1" {
		t.Fatalf("got %v", m)
	}
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"NOPE"}`))
	if m := readJSON(t, c); m["code"] != "unknown_type" {
		t.Fatalf("got %v", m)
	}
	if !hub.Connected("dev-1") || hub.Connected("dev-2") {
		t.Fatal("connected registry")
	}
	if !hub.SendToDevice("dev-1", map[string]string{"type": "X"}) || hub.SendToDevice("dev-2", map[string]string{"type": "X"}) {
		t.Fatal("send result")
	}
	_ = readJSON(t, c)
	hub.Broadcast(map[string]string{"type": "B"})
	if readJSON(t, c)["type"] != "B" {
		t.Fatal("broadcast")
	}
	hub.DisconnectDevice("dev-1")
	rctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if _, _, err := c.Read(rctx); err == nil {
		t.Fatal("socket must close after DisconnectDevice")
	}
	deadline := time.Now().Add(2 * time.Second)
	for hub.Connected("dev-1") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if hub.Connected("dev-1") {
		t.Fatal("registry not cleared")
	}
}

// TestPresenceHooks: the presence hook fires when a device opens its first socket and when it closes its last
// one, never for a second socket of the same device (Phase 5B DEVICE_CONNECTED / DEVICE_DISCONNECTED).
func TestPresenceHooks(t *testing.T) {
	hub, srv := newServer(t, clock.Real{})
	events := make(chan string, 10)
	hub.OnPresence(func(deviceID string, connected bool) {
		if connected {
			events <- "+" + deviceID
		} else {
			events <- "-" + deviceID
		}
	})
	next := func() string {
		select {
		case e := <-events:
			return e
		case <-time.After(3 * time.Second):
			return "timeout"
		}
	}
	c1, _, err := dial(t, wsURL(srv, hub.IssueTicket("dev-p")), "")
	if err != nil {
		t.Fatal(err)
	}
	_ = readJSON(t, c1)
	if e := next(); e != "+dev-p" {
		t.Fatalf("first socket: %s", e)
	}
	c2, _, err := dial(t, wsURL(srv, hub.IssueTicket("dev-p")), "")
	if err != nil {
		t.Fatal(err)
	}
	_ = readJSON(t, c2)
	_ = c1.Close(websocket.StatusNormalClosure, "")
	select {
	case e := <-events:
		t.Fatalf("a second socket opening or one of two closing must not fire: %s", e)
	case <-time.After(300 * time.Millisecond):
	}
	_ = c2.Close(websocket.StatusNormalClosure, "")
	if e := next(); e != "-dev-p" {
		t.Fatalf("last socket: %s", e)
	}
}

// syncBuffer is a log sink safe for concurrent writes.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func bareHub(log io.Writer, reg *metrics.Registry) *Hub {
	return NewHub(Config{Clock: clock.Real{}, IPs: clientip.New([]netip.Prefix{}), Log: slog.New(slog.NewTextHandler(log, nil)), Metrics: reg})
}

func bareConn(deviceID string) *conn {
	return &conn{deviceID: deviceID, out: make(chan []byte, 1), cancel: func() {}}
}

// TestPresenceOrderAcrossSockets: sockets of one device opening and closing concurrently (a reconnect racing
// the old socket's close) announce strictly alternating connected/disconnected, in the order the device's
// socket count changed, and the last event matches the final state: a stale DISCONNECTED never follows a
// newer CONNECTED (QA 5B round 2, P2-3).
func TestPresenceOrderAcrossSockets(t *testing.T) {
	hub := bareHub(io.Discard, nil)
	hub.presenceCap = 1 << 16 // this test checks ordering, not dropping
	t.Cleanup(hub.Close)
	var mu sync.Mutex
	seen := map[string][]bool{}
	hub.OnPresence(func(deviceID string, connected bool) {
		mu.Lock()
		seen[deviceID] = append(seen[deviceID], connected)
		mu.Unlock()
	})
	devices := []string{"dev-a", "dev-b", "dev-c"}
	var wg sync.WaitGroup
	for _, d := range devices {
		for g := 0; g < 8; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 200; i++ {
					c := bareConn(d)
					hub.add(c)
					if i%3 == 0 {
						runtime.Gosched()
					}
					hub.remove(c)
				}
			}()
		}
	}
	wg.Wait()
	// One device left connected at the end: its last event must say so. Events are delivered asynchronously,
	// so wait until every device's final state has arrived (dev-a connected, dev-b and dev-c disconnected) before
	// checking the order; waiting for dev-a alone raced with the delivery of the others' last events.
	last := bareConn("dev-a")
	hub.add(last)
	// A device's final state can show for a moment while its later events are still queued (CI saw dev-b end on
	// "connected" after an earlier check passed), so settled also needs every presence queue empty, and it must hold
	// across two checks so an event a worker has already dequeued is delivered too.
	settledOnce := func() bool {
		for _, q := range hub.presenceQ {
			if len(q) > 0 {
				return false
			}
		}
		mu.Lock()
		defer mu.Unlock()
		for _, d := range devices {
			evs := seen[d]
			if len(evs) == 0 || evs[len(evs)-1] != (d == "dev-a") {
				return false
			}
		}
		return true
	}
	settled := func() bool {
		if !settledOnce() {
			return false
		}
		time.Sleep(50 * time.Millisecond)
		return settledOnce()
	}
	deadline := time.Now().Add(5 * time.Second)
	for !settled() {
		if time.Now().After(deadline) {
			mu.Lock()
			n := len(seen["dev-a"])
			mu.Unlock()
			t.Fatalf("final presence never settled (dev-a has %d events)", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if n := hub.PresenceDropped(); n != 0 {
		t.Fatalf("dropped %d events with a large queue", n)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, d := range devices {
		evs := seen[d]
		if len(evs) == 0 {
			t.Fatalf("%s: no events", d)
		}
		for i, connected := range evs {
			if connected != (i%2 == 0) {
				t.Fatalf("%s: event %d is %v; events must alternate starting with connected (%v)", d, i, connected, evs[max(0, i-3):i+1])
			}
		}
	}
	if evs := seen["dev-b"]; evs[len(evs)-1] {
		t.Fatal("dev-b closed all its sockets but its last event says connected")
	}
}

// TestPresenceDropWhenFull: a full worker queue drops the event without blocking the socket, logs it and counts
// it in sa_ws_presence_dropped_total.
func TestPresenceDropWhenFull(t *testing.T) {
	logs := &syncBuffer{}
	reg := metrics.New()
	hub := bareHub(logs, reg)
	hub.presenceCap = 1
	t.Cleanup(hub.Close)
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var mu sync.Mutex
	var got []string
	hub.OnPresence(func(deviceID string, connected bool) {
		mu.Lock()
		got = append(got, fmt.Sprintf("%s %v", deviceID, connected))
		mu.Unlock()
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
	})
	c1 := bareConn("dev-full")
	hub.add(c1) // taken by the worker, which then blocks in the hook
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("hook never ran")
	}
	done := make(chan struct{})
	go func() {
		hub.remove(c1)                // fills the queue (capacity 1)
		hub.add(bareConn("dev-full")) // dropped
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("a full presence queue blocked the socket")
	}
	if n := hub.PresenceDropped(); n != 1 {
		t.Fatalf("dropped = %d, want 1", n)
	}
	if v := reg.Counter("sa_ws_presence_dropped_total", "").Value(); v != 1 {
		t.Fatalf("metric = %d, want 1", v)
	}
	if !strings.Contains(logs.String(), "presence queue full") {
		t.Fatalf("drop not logged: %q", logs.String())
	}
	if strings.Contains(logs.String(), "dev-full") {
		t.Fatal("the log line must not carry the device id")
	}
	close(release)
	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("queued event not delivered after release (%d)", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if got[0] != "dev-full true" || got[1] != "dev-full false" {
		t.Fatalf("delivered %v", got)
	}
}

// TestPresenceCloseStopsWorkers: Close waits for a running hook, stops every worker (no goroutine left
// behind), discards queued events, makes later socket changes announce nothing, and can be called twice.
// settledGoroutines waits until goroutines left by earlier tests have exited (the count holds still for 100 ms),
// so a baseline taken now is not overcounted by one that exits a moment later.
func settledGoroutines() int {
	n, stable := runtime.NumGoroutine(), 0
	for i := 0; i < 100 && stable < 5; i++ {
		time.Sleep(20 * time.Millisecond)
		if m := runtime.NumGoroutine(); m == n {
			stable++
		} else {
			n, stable = m, 0
		}
	}
	return n
}

func TestPresenceCloseStopsWorkers(t *testing.T) {
	base := settledGoroutines()
	hub := bareHub(io.Discard, nil)
	started := make(chan struct{})
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	hub.OnPresence(func(string, bool) {
		mu.Lock()
		calls++
		first := calls == 1
		mu.Unlock()
		if first {
			close(started)
			<-release
		}
	})
	if n := runtime.NumGoroutine(); n < base+presenceShards {
		t.Fatalf("workers not started: %d goroutines, base %d", n, base)
	}
	c := bareConn("dev-x")
	hub.add(c)
	<-started
	hub.remove(c) // queued behind the running hook, then discarded by Close
	closed := make(chan struct{})
	go func() {
		hub.Close()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("Close returned while a hook was still running")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not return")
	}
	hub.Close() // idempotent
	hub.add(bareConn("dev-y"))
	hub.remove(bareConn("dev-y"))
	deadline := time.Now().Add(3 * time.Second)
	for runtime.NumGoroutine() > base {
		if time.Now().After(deadline) {
			t.Fatalf("goroutines leaked: %d, base %d", runtime.NumGoroutine(), base)
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("hook ran %d times; events after Close must be discarded", calls)
	}
	// A hub closed before any hook was registered starts no workers.
	idle := bareHub(io.Discard, nil)
	idle.Close()
	idle.OnPresence(func(string, bool) {})
	if idle.presenceQ != nil {
		t.Fatal("workers started after Close")
	}
}
