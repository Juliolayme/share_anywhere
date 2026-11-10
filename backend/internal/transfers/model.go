// Package transfers keeps the per-receiver, per-file transfer records and their state machine
// (docs/ARCHITECTURE.md §4.5). Bytes never pass through the server: clients move them peer to peer and
// report state, verified bytes and the route here for history, controls and metrics.
package transfers

import (
	"net/http"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// States (docs/ARCHITECTURE.md §4.5).
const (
	Pending      = "PENDING"
	Connecting   = "CONNECTING"
	Transferring = "TRANSFERRING"
	Paused       = "PAUSED"
	Disconnected = "DISCONNECTED"
	Reconnecting = "RECONNECTING"
	Resuming     = "RESUMING"
	Completed    = "COMPLETED"
	Failed       = "FAILED"
	Cancelled    = "CANCELLED"
)

// Routes a client may report (metrics only; the client chooses, docs/PRODUCT_REQUIREMENTS.md §6.3).
var Routes = map[string]bool{"direct": true, "relay": true, "cloud": true}

// next lists the states a transfer may move to. Reporting the current state again is always allowed (a
// progress update) and does not appear here.
var next = map[string][]string{
	Pending:      {Connecting, Paused, Failed, Cancelled},
	Connecting:   {Transferring, Resuming, Disconnected, Paused, Failed, Cancelled},
	Transferring: {Paused, Disconnected, Completed, Failed, Cancelled},
	Paused:       {Connecting, Resuming, Transferring, Failed, Cancelled},
	Disconnected: {Reconnecting, Connecting, Paused, Failed, Cancelled},
	Reconnecting: {Resuming, Connecting, Disconnected, Paused, Failed, Cancelled},
	Resuming:     {Transferring, Disconnected, Paused, Completed, Failed, Cancelled},
}

// Terminal reports whether no further transition is possible.
func Terminal(s string) bool { return s == Completed || s == Failed || s == Cancelled }

// CanMove reports whether from → to is a valid transition (same state counts as valid unless terminal
// states differ).
func CanMove(from, to string) bool {
	if from == to {
		return true
	}
	for _, s := range next[from] {
		if s == to {
			return true
		}
	}
	return false
}

// Transfer is one file to one receiver.
type Transfer struct {
	ID            string    `json:"id"`
	SessionID     string    `json:"session_id"`
	ParticipantID string    `json:"participant_id"`
	FileID        string    `json:"file_id"`
	Status        string    `json:"status"`
	VerifiedBytes int64     `json:"verified_bytes"`
	Size          int64     `json:"size"`
	Route         *string   `json:"route"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// List is GET /v1/sessions/{id}/transfers. The sender sees every transfer and each receiver's capability
// hash; a JOINED receiver sees its own transfers and its own capability.
type List struct {
	Role       string         `json:"role"`
	Transfers  []Transfer     `json:"transfers"`
	Peers      []sharing.Peer `json:"peers,omitempty"`
	Capability string         `json:"capability,omitempty"`
	ServerTime time.Time      `json:"server_time"`
}

// Report is POST /v1/transfers/{id}/report.
type Report struct {
	Status        string  `json:"status"`
	VerifiedBytes int64   `json:"verified_bytes"`
	Route         *string `json:"route,omitempty"`
}

// Event is the WebSocket event sent to the sender and the receiver when a transfer changes.
type Event struct {
	Type      string   `json:"type"` // TRANSFER_UPDATED
	SessionID string   `json:"session_id"`
	Transfer  Transfer `json:"transfer"`
}

// Error is a documented API error.
type Error struct {
	Status int
	Code   string
	Msg    string
	Wait   time.Duration
}

func (e *Error) Error() string { return e.Code }

func errf(status int, code, msg string) *Error { return &Error{Status: status, Code: code, Msg: msg} }

var (
	errNotFound   = errf(http.StatusNotFound, "not_found", "No such transfer.")
	errTransition = errf(http.StatusConflict, "invalid_transition", "The transfer cannot move to that state now.")
	errBytes      = errf(http.StatusBadRequest, "invalid_bytes", "Verified bytes must not decrease or exceed the file size.")
	errCapability = errf(http.StatusForbidden, "capability_required", "This action needs the transfer capability.")
	errComplete   = errf(http.StatusConflict, "not_verified", "A transfer completes only after every byte is verified.")
	errReporter   = errf(http.StatusForbidden, "receiver_only", "Only the receiver reports transfer progress.")
	errUseResume  = errf(http.StatusConflict, "use_resume", "Resume a paused transfer with the resume action.")
	errEnded      = errf(http.StatusConflict, "session_ended", "This session has ended.")
	errRoute      = errf(http.StatusBadRequest, "invalid_route", "Route must be direct, relay or cloud.")
	errStatus     = errf(http.StatusBadRequest, "invalid_status", "Unknown transfer status.")
)
