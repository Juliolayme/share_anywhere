package signaling

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/ws"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

type router struct{}

func (router) SignalRoute(_ context.Context, from, session, to string) (string, string, error) {
	if from == "sender-dev" && to == "rx-pid" {
		return "sender-pid", "rx-dev", nil
	}
	if to == "boom" {
		return "", "", errors.New("db down")
	}
	return "", "", sharing.ErrNotFound
}

type sink struct {
	got     []any
	offline bool
}

func (s *sink) SendToDevice(id string, v any) bool {
	if s.offline {
		return false
	}
	s.got = append(s.got, v)
	return true
}

func TestRelay(t *testing.T) {
	out := &sink{}
	h := Handler(router{}, out)
	msg := `{"type":"OFFER","session_id":"s","to":"rx-pid","payload":{"sdp":"v=0"}}`
	if err := h(context.Background(), "sender-dev", json.RawMessage(msg)); err != nil {
		t.Fatal(err)
	}
	o := out.got[0].(Outbound)
	if o.Type != "OFFER" || o.From != "sender-pid" || string(o.Payload) != `{"sdp":"v=0"}` {
		t.Fatalf("forwarded %+v", o)
	}
	code := func(err error) string {
		var e *ws.Error
		if errors.As(err, &e) {
			return e.Code
		}
		return ""
	}
	if c := code(h(context.Background(), "intruder", json.RawMessage(msg))); c != "not_found" {
		t.Fatalf("unauthorized: %q", c)
	}
	if c := code(h(context.Background(), "sender-dev", json.RawMessage(`{"type":"OFFER"}`))); c != "bad_message" {
		t.Fatalf("no payload: %q", c)
	}
	big := `{"type":"OFFER","session_id":"s","to":"rx-pid","payload":"` + strings.Repeat("a", MaxPayload) + `"}`
	if c := code(h(context.Background(), "sender-dev", json.RawMessage(big))); c != "payload_too_large" {
		t.Fatalf("big: %q", c)
	}
	out.offline = true
	if c := code(h(context.Background(), "sender-dev", json.RawMessage(msg))); c != "peer_offline" {
		t.Fatalf("offline: %q", c)
	}
	if err := h(context.Background(), "sender-dev", json.RawMessage(`{"type":"OFFER","session_id":"s","to":"boom","payload":1}`)); err == nil || code(err) != "" {
		t.Fatalf("internal errors pass through: %v", err)
	}
}
