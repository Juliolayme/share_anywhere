// Package sharing implements share sessions: creation with a six-digit code, link and QR sharing one
// 10-minute join window, open join by default with optional approval, protected mode, sender controls,
// lifetimes, and participant-scoped authorization for signaling and TURN (docs/ARCHITECTURE.md §4,
// docs/SECURITY_MODEL.md §3, §5, §6, docs/API.md §2.2).
package sharing

import (
	"fmt"
	"net/http"
	"time"
)

// Limits and lifetimes (docs/SECURITY_MODEL.md §3, §5, §6).
const (
	JoinWindow        = 10 * time.Minute
	JoinTicketTTL     = 5 * time.Minute
	MaxReceivers      = 5
	IdleTimeout       = 30 * time.Minute
	GuestLifetime     = 24 * time.Hour
	AccountLifetime   = 72 * time.Hour
	PurgeAfterEnd     = 7 * 24 * time.Hour
	ProtectedDuration = 30 * time.Minute
	LockoutDuration   = 30 * time.Minute
	MaxFiles          = 1000
	MaxSessionBytes   = int64(20e9)
	GuestOpenSessions = 2
	AcctOpenSessions  = 5
)

// Session statuses, join window states, participant statuses.
const (
	StatusWaiting = "WAITING"
	StatusActive  = "ACTIVE"
	StatusClosed  = "CLOSED"
	StatusExpired = "EXPIRED"

	WindowOpen          = "OPEN"
	WindowExpired       = "EXPIRED"
	WindowEndedFull     = "ENDED_FULL"
	WindowEndedBySender = "ENDED_BY_SENDER"

	PRequested = "REQUESTED"
	PJoined    = "JOINED"
	PLeft      = "LEFT"
	PRemoved   = "REMOVED"
	PBlocked   = "BLOCKED"
	PRejected  = "REJECTED"
)

// Error is an API error with its HTTP status and code (docs/API.md §3).
type Error struct {
	Status int
	Code   string
	Msg    string
	Wait   time.Duration
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s", e.Status, e.Code) }

func errf(status int, code, msg string) *Error { return &Error{Status: status, Code: code, Msg: msg} }

var (
	ErrNotFound       = errf(http.StatusNotFound, "not_found", "No such session.")
	ErrInvalid        = errf(http.StatusBadRequest, "invalid_request", "Check the request.")
	ErrOverLimit      = errf(http.StatusBadRequest, "over_limit", "A session holds at most 20 GB and 1,000 files.")
	ErrSessionFull    = errf(http.StatusConflict, "session_full", "This session already has 5 receivers.")
	ErrTooManyOpen    = errf(http.StatusConflict, "too_many_open_sessions", "Close an open session before starting another.")
	ErrWindowExpired  = errf(http.StatusGone, "join_window_expired", "This code or link has expired. Ask the sender for a new code.")
	ErrNotAccepting   = errf(http.StatusGone, "session_not_accepting", "The sender is not accepting new receivers.")
	ErrSessionExpired = errf(http.StatusGone, "session_expired", "This session has ended.")
	ErrBlocked        = errf(http.StatusForbidden, "blocked", "You can't join this session.")
	ErrForbidden      = errf(http.StatusForbidden, "forbidden", "Only the sender can do that.")
	ErrConflict       = errf(http.StatusConflict, "invalid_state", "That action doesn't apply right now.")
)

func rateLimited(code string, wait time.Duration) *Error {
	return &Error{Status: http.StatusTooManyRequests, Code: code, Msg: "Too many attempts. Try again later.", Wait: wait}
}

// Caller is the authenticated device making a request, with what the server knows about it.
type Caller struct {
	DeviceID    string
	SignedIn    bool
	IPKey       string
	DisplayName string
	Platform    string
}

// FileInput is one file in a create request (metadata only; bytes never reach the server).
type FileInput struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Mime string `json:"mime"`
}

// File is a shared file as participants see it.
type File struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	Mime string `json:"mime"`
}

// JoinWindowView is the join window state with server time for client countdowns.
type JoinWindowView struct {
	State    string    `json:"state"`
	OpenedAt time.Time `json:"opened_at"`
	EndsAt   time.Time `json:"ends_at"`
	Seq      int       `json:"seq"`
}

// Capacity counts receivers against the five-receiver cap.
type Capacity struct {
	Joined    int `json:"joined"`
	Requested int `json:"requested"`
	Max       int `json:"max"`
}

// Participant is a participant as the sender (or the participant itself) sees it.
type Participant struct {
	ID            string     `json:"id"`
	Role          string     `json:"role"`
	Status        string     `json:"status"`
	DisplayName   string     `json:"display_name"`
	Platform      string     `json:"platform"`
	SignedIn      bool       `json:"signed_in"`
	SecurityWords []string   `json:"security_words,omitempty"`
	JoinedVia     string     `json:"joined_via,omitempty"`
	RequestReason string     `json:"request_reason,omitempty"`
	JoinedAt      *time.Time `json:"joined_at,omitempty"`
}

// PeerSummary is the other side as a receiver sees the sender.
type PeerSummary struct {
	ParticipantID string `json:"participant_id"`
	DisplayName   string `json:"display_name"`
	Platform      string `json:"platform"`
	SignedIn      bool   `json:"signed_in"`
}

// SessionView is GET /v1/sessions/{id}. Fields are filled by role and state: the sender sees everything,
// including the code and link; a JOINED receiver sees files and its own participant; a REQUESTED receiver
// sees the preview and its own status; an ended participant sees only its own status.
type SessionView struct {
	ID              string          `json:"id"`
	Role            string          `json:"role"`
	Status          string          `json:"status"`
	RequireApproval bool            `json:"require_approval"`
	JoinWindow      *JoinWindowView `json:"join_window,omitempty"`
	Code            string          `json:"code,omitempty"`
	LinkToken       string          `json:"link_token,omitempty"`
	JoinURL         string          `json:"join_url,omitempty"`
	Capacity        *Capacity       `json:"capacity,omitempty"`
	Participants    []Participant   `json:"participants,omitempty"`
	Sender          *PeerSummary    `json:"sender,omitempty"`
	Me              *Participant    `json:"me,omitempty"`
	Files           []File          `json:"files,omitempty"`
	TotalBytes      int64           `json:"total_bytes"`
	FileCount       int             `json:"file_count"`
	ProtectedMode   bool            `json:"protected_mode"`
	ExpiresAt       time.Time       `json:"expires_at"`
	ServerTime      time.Time       `json:"server_time"`
}

// Preview is the result of resolving a code or link: what a receiver sees before tapping Receive.
type Preview struct {
	SessionID        string       `json:"session_id"`
	Sender           *PeerSummary `json:"sender"`
	Files            []File       `json:"files"`
	TotalBytes       int64        `json:"total_bytes"`
	FileCount        int          `json:"file_count"`
	RequireApproval  bool         `json:"require_approval"`
	ProtectedMode    bool         `json:"protected_mode"`
	JoinWindowEndsAt time.Time    `json:"join_window_ends_at"`
	JoinTicket       string       `json:"join_ticket"`
	TicketExpiresAt  time.Time    `json:"join_ticket_expires_at"`
	Via              string       `json:"via"`
	Existing         string       `json:"existing_status,omitempty"`
	ServerTime       time.Time    `json:"server_time"`
}
