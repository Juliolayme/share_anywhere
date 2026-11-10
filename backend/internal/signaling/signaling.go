// Package signaling relays WebRTC signaling (OFFER, ANSWER, ICE_CANDIDATE) over the WebSocket hub between
// the sender and a JOINED receiver of the same live session (docs/API.md §4). The server never inspects
// SDP or candidates; it only checks who may talk to whom and forwards.
package signaling

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/ws"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// MaxPayload bounds an SDP or candidate payload.
const MaxPayload = 32 << 10

// Types are the relayed message types.
var Types = []string{"OFFER", "ANSWER", "ICE_CANDIDATE"}

// Router authorizes a route (implemented by sharing.Service).
type Router interface {
	SignalRoute(ctx context.Context, fromDevice, sessionID, toParticipant string) (fromParticipant, toDevice string, err error)
}

// Sender delivers to a device's sockets (implemented by ws.Hub).
type Sender interface {
	SendToDevice(deviceID string, v any) bool
}

// Inbound is a client message.
type Inbound struct {
	Type      string          `json:"type"`
	Ref       string          `json:"ref,omitempty"`
	SessionID string          `json:"session_id"`
	To        string          `json:"to"`
	Payload   json.RawMessage `json:"payload"`
}

// Outbound is what the target receives.
type Outbound struct {
	Type      string          `json:"type"`
	SessionID string          `json:"session_id"`
	From      string          `json:"from"`
	Payload   json.RawMessage `json:"payload"`
}

// Handler returns the hub handler for relayed messages.
func Handler(router Router, out Sender) ws.Handler {
	return func(ctx context.Context, deviceID string, raw json.RawMessage) error {
		var m Inbound
		if err := json.Unmarshal(raw, &m); err != nil || len(m.Payload) == 0 {
			return &ws.Error{Code: "bad_message"}
		}
		if len(m.Payload) > MaxPayload {
			return &ws.Error{Code: "payload_too_large"}
		}
		from, toDevice, err := router.SignalRoute(ctx, deviceID, m.SessionID, m.To)
		var se *sharing.Error
		if errors.As(err, &se) {
			return &ws.Error{Code: "not_found"} // not a participant, not joined, or not a sender–receiver pair
		}
		if err != nil {
			return err
		}
		if !out.SendToDevice(toDevice, Outbound{Type: m.Type, SessionID: m.SessionID, From: from, Payload: m.Payload}) {
			return &ws.Error{Code: "peer_offline"}
		}
		return nil
	}
}

// Register wires the relay into the hub.
func Register(hub *ws.Hub, router Router) {
	h := Handler(router, hub)
	for _, t := range Types {
		hub.Handle(t, h)
	}
}
