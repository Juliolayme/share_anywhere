package ws

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
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
