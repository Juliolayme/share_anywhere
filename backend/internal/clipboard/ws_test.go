package clipboard

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// socket is an open WebSocket whose frames a background reader collects (a Read with a deadline would close
// the connection, so "nothing arrived" is checked on the channel).
type socket struct {
	c  *websocket.Conn
	in chan map[string]any
}

func (e *env) connect(srv *httptest.Server, deviceID string) *socket {
	e.t.Helper()
	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/ws?ticket=" + e.hub.IssueTicket(deviceID)
	c, resp, err := websocket.Dial(dctx, url, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		e.t.Fatal(err)
	}
	s := &socket{c: c, in: make(chan map[string]any, 32)}
	go func() {
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				close(s.in)
				return
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			if strings.Contains(string(data), "ciphertext") || strings.Contains(string(data), "nonce") {
				m["_leak"] = true
			}
			s.in <- m
		}
	}()
	e.t.Cleanup(func() { _ = c.CloseNow() })
	if m := s.next(e.t); m["type"] != "WELCOME" {
		e.t.Fatalf("first frame: %v", m)
	}
	return s
}

func (s *socket) next(t *testing.T) map[string]any {
	t.Helper()
	select {
	case m, ok := <-s.in:
		if !ok {
			t.Fatal("socket closed")
		}
		if m["_leak"] == true {
			t.Fatalf("ciphertext or nonce over WebSocket: %v", m)
		}
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("no WebSocket message")
	}
	return nil
}

func (s *socket) quiet(t *testing.T, who string) {
	t.Helper()
	select {
	case m := <-s.in:
		t.Fatalf("%s must not receive anything, got %v", who, m)
	case <-time.After(200 * time.Millisecond):
	}
}

// TestWebSocketFanOut: CLIPBOARD_* metadata goes to every open socket of the account's devices that have a live
// added session at send time (the origin included), never to a not-added device, a device revoked while its
// socket stays open, or another account; DEVICE_CONNECTED / DEVICE_DISCONNECTED go to the account's other added
// devices when an added device opens its first or closes its last socket.
func TestWebSocketFanOut(t *testing.T) {
	e := newEnv(t, 100)
	srv := httptest.NewServer(e.mux)
	t.Cleanup(srv.Close)
	a, tokA := e.signup("kim@example.com")
	b, _ := e.signin("kim@example.com", true)
	n, _ := e.signin("kim@example.com", false)
	r, _ := e.signin("kim@example.com", true)
	o, tokO := e.signup("lou@example.com")

	sa := e.connect(srv, a.Device.ID)
	sb := e.connect(srv, b.Device.ID)
	if m := sa.next(t); m["type"] != "DEVICE_CONNECTED" || m["device_id"] != b.Device.ID {
		t.Fatalf("A on B's connect: %v", m)
	}
	sn := e.connect(srv, n.Device.ID) // not added: announces nothing
	sr := e.connect(srv, r.Device.ID)
	for _, s := range []*socket{sa, sb} {
		if m := s.next(t); m["type"] != "DEVICE_CONNECTED" || m["device_id"] != r.Device.ID {
			t.Fatalf("on R's connect: %v", m)
		}
	}
	so := e.connect(srv, o.Device.ID)
	sr.quiet(t, "R")
	sn.quiet(t, "the not-added device")

	// R is revoked; its device identity (and so its socket) survives, but it is no longer an added device.
	e.want(e.do("DELETE", "/v1/devices/"+r.Device.ID, tokA, nil), 204, "")

	evID := newID()
	created := e.do("POST", "/v1/clipboard/events", tokA, eventBody(evID, 1, 42))
	e.want(created, 201, "")
	for who, s := range map[string]*socket{"A (origin)": sa, "B": sb} {
		m := s.next(t)
		if m["type"] != "CLIPBOARD_EVENT_CREATED" || m["event_id"] != evID || m["seq"].(float64) != 1 || m["origin_device_id"] != a.Device.ID ||
			m["payload_size"].(float64) != 42 || m["key_version"].(float64) != 1 || m["created_at"] != created.str("created_at") || len(m) != 7 {
			t.Fatalf("%s: %v", who, m)
		}
	}
	// A retry stores nothing and announces nothing.
	e.want(e.do("POST", "/v1/clipboard/events", tokA, eventBody(evID, 1, 42)), 201, "")
	e.want(e.do("DELETE", "/v1/clipboard/events/"+evID, tokA, nil), 204, "")
	for _, s := range []*socket{sa, sb} {
		if m := s.next(t); m["type"] != "CLIPBOARD_EVENT_DELETED" || m["event_id"] != evID || m["seq"].(float64) != 2 || len(m) != 3 {
			t.Fatalf("deleted: %v", m)
		}
	}
	e.want(e.do("POST", "/v1/clipboard/events", tokA, eventBody(newID(), 1, 5)), 201, "")
	e.want(e.do("POST", "/v1/clipboard/events", tokA, eventBody(newID(), 1, 5)), 201, "")
	e.want(e.do("DELETE", "/v1/clipboard/history", tokA, nil), 204, "")
	for _, s := range []*socket{sa, sb} {
		_, _ = s.next(t), s.next(t) // the two CREATED
		if m := s.next(t); m["type"] != "CLIPBOARD_HISTORY_CLEARED" || m["seq"].(float64) != 6 || len(m) != 2 {
			t.Fatalf("cleared: %v", m)
		}
	}
	e.want(e.do("PUT", "/v1/clipboard/settings", tokA, map[string]any{"paused": true, "retention_days": 2, "sensitive_skip": false}), 200, "")
	for _, s := range []*socket{sa, sb} {
		if m := s.next(t); m["type"] != "CLIPBOARD_SETTINGS_UPDATED" || m["paused"] != true || m["retention_days"].(float64) != 2 || m["sensitive_skip"] != false {
			t.Fatalf("settings: %v", m)
		}
	}
	// Another account's activity reaches only that account.
	e.want(e.do("PUT", "/v1/clipboard/settings", tokO, map[string]any{"paused": false, "retention_days": 7, "sensitive_skip": true}), 200, "")
	if m := so.next(t); m["type"] != "CLIPBOARD_SETTINGS_UPDATED" {
		t.Fatalf("other account: %v", m)
	}
	sr.quiet(t, "the revoked device")
	sn.quiet(t, "the not-added device")
	sa.quiet(t, "A (another account's event)")

	// B closes its only socket: A hears DEVICE_DISCONNECTED; the revoked device's sockets announce nothing.
	_ = sb.c.Close(websocket.StatusNormalClosure, "")
	if m := sa.next(t); m["type"] != "DEVICE_DISCONNECTED" || m["device_id"] != b.Device.ID {
		t.Fatalf("A on B's disconnect: %v", m)
	}
	_ = sr.c.Close(websocket.StatusNormalClosure, "")
	_ = sn.c.Close(websocket.StatusNormalClosure, "")
	sa.quiet(t, "A (departed and not-added devices disconnecting)")
}
