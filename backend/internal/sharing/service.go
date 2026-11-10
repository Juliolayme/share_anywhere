package sharing

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/metrics"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
)

// Notifier delivers WebSocket events (implemented by the platform ws hub).
type Notifier interface {
	SendToDevice(deviceID string, v any) bool
	Broadcast(v any)
	Connected(deviceID string) bool
}

// Limits are the rate limits and lockouts this package enforces (docs/SECURITY_MODEL.md §5).
type Limits struct {
	CreateDevice, CreateIP *ratelimit.Limiter
	LookupIP, LookupDevice *ratelimit.Limiter
	FailedIP, FailedDevice *ratelimit.Limiter
	LinkIP, LinkDevice     *ratelimit.Limiter
	Join, JoinIP           *ratelimit.Limiter
	Renew                  *ratelimit.Limiter
	TurnGuest, TurnAccount *ratelimit.Limiter
	TurnIP                 *ratelimit.Limiter
}

// ScaledLimits returns the defaults multiplied by m (m > 1 only on test stacks, see config).
func ScaledLimits(c clock.Clock, m int) Limits {
	if m < 1 {
		m = 1
	}
	r := func(n int, w time.Duration) *ratelimit.Limiter {
		return ratelimit.New(ratelimit.Rule{Limit: n * m, Window: w}, c)
	}
	return Limits{
		CreateDevice: r(10, time.Hour), CreateIP: r(30, time.Hour),
		LookupIP: r(10, time.Minute), LookupDevice: r(5, time.Minute),
		FailedIP: r(10, time.Hour), FailedDevice: r(5, 10*time.Minute),
		LinkIP: r(30, time.Minute), LinkDevice: r(10, time.Minute),
		Join: r(10, time.Minute), JoinIP: r(30, time.Minute),
		Renew:     r(20, time.Hour),
		TurnGuest: r(20, time.Hour), TurnAccount: r(60, time.Hour), TurnIP: r(120, time.Hour),
	}
}

// Config wires the service.
type Config struct {
	Pool      *pgxpool.Pool
	Clock     clock.Clock
	Secret    []byte
	Notify    Notifier
	Limits    Limits
	Protected *ProtectedMode
	PublicURL string // base for join links, e.g. https://share.example
	Log       *slog.Logger
	Metrics   *metrics.Registry // optional
}

// counters are the aggregate metrics this package reports (never per person).
type counters struct {
	sessionsCreated, joins, requests, blocks, lookupsFailed, lockouts, protectedOn, protectedSeconds *metrics.Counter
}

func newCounters(r *metrics.Registry, p *ProtectedMode) counters {
	if r == nil {
		r = metrics.New()
	}
	r.Gauge("sa_protected_mode_active", "1 while protected mode is on (code joins need approval).", func() float64 {
		if on, _ := p.Active(); on {
			return 1
		}
		return 0
	})
	return counters{
		sessionsCreated:  r.Counter("sa_sessions_created_total", "Share sessions created."),
		joins:            r.Counter("sa_joins_total", "Receivers admitted as JOINED."),
		requests:         r.Counter("sa_join_requests_total", "Joins that landed in REQUESTED (approval or protected mode)."),
		blocks:           r.Counter("sa_blocks_total", "Receivers blocked by senders."),
		lookupsFailed:    r.Counter("sa_code_lookups_failed_total", "Failed six-digit code lookups (unknown or expired codes)."),
		lockouts:         r.Counter("sa_code_lookup_lockouts_total", "30-minute lockouts started for an address or a device."),
		protectedOn:      r.Counter("sa_protected_mode_activations_total", "Times protected mode switched on."),
		protectedSeconds: r.Counter("sa_protected_mode_seconds_total", "Seconds spent in protected mode (approximate, from maintenance ticks)."),
	}
}

// Service implements share sessions.
type Service struct {
	cfg  Config
	keys keys

	mu             sync.Mutex
	lockout        map[string]time.Time // "ip:<key>" / "dev:<id>" → locked until
	protectedWasOn bool
	lastTick       time.Time
	m              counters
}

// NewService returns the sharing service.
func NewService(cfg Config) *Service {
	return &Service{cfg: cfg, keys: deriveKeys(cfg.Secret), lockout: map[string]time.Time{}, m: newCounters(cfg.Metrics, cfg.Protected)}
}

func (s *Service) now() time.Time { return s.cfg.Clock.Now().UTC() }

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ValidID reports whether s looks like a UUID (avoids database casts on garbage input).
func ValidID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
				return false
			}
		}
	}
	return true
}

func (s *Service) joinURL(token string) string {
	return strings.TrimRight(s.cfg.PublicURL, "/") + "/j/" + token
}

// ---- session row ----

type sessionRow struct {
	ID, OwnerDeviceID, Status, WindowState string
	RequireApproval                        bool
	WindowSeq                              int
	WindowOpenedAt, WindowEndsAt           time.Time
	CodeEnc, LinkEnc                       []byte
	CreatedAt, LastActivityAt, ExpiresAt   time.Time
	EndedAt                                *time.Time
}

const sessionCols = `id::text, owner_device_id::text, status, join_window_state, require_approval, join_window_seq,
	join_window_opened_at, join_window_ends_at, code_enc, link_enc, created_at, last_activity_at, expires_at, ended_at`

func scanSession(row pgx.Row) (sessionRow, error) {
	var r sessionRow
	err := row.Scan(&r.ID, &r.OwnerDeviceID, &r.Status, &r.WindowState, &r.RequireApproval, &r.WindowSeq,
		&r.WindowOpenedAt, &r.WindowEndsAt, &r.CodeEnc, &r.LinkEnc, &r.CreatedAt, &r.LastActivityAt, &r.ExpiresAt, &r.EndedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	return r, err
}

func (r sessionRow) live() bool { return r.Status == StatusWaiting || r.Status == StatusActive }

// effectiveWindow treats an open window past its end as expired even before the job runs.
func (r sessionRow) effectiveWindow(now time.Time) string {
	if r.WindowState == WindowOpen && !now.Before(r.WindowEndsAt) {
		return WindowExpired
	}
	return r.WindowState
}

func windowError(state string) *Error {
	switch state {
	case WindowEndedFull:
		return ErrSessionFull
	case WindowEndedBySender:
		return ErrNotAccepting
	default:
		return ErrWindowExpired
	}
}

// ---- participant rows ----

type participantRow struct {
	ID, SessionID, DeviceID, Role, Status, DisplayName, Platform string
	SignedIn                                                     bool
	Words, JoinedVia, RequestReason, IPHash                      *string
	JoinedAt                                                     *time.Time
}

const participantCols = `id::text, session_id::text, device_id::text, role, status, display_name, platform, signed_in,
	security_words, joined_via, request_reason, ip_hash, joined_at`

func scanParticipant(row pgx.Row) (participantRow, error) {
	var p participantRow
	err := row.Scan(&p.ID, &p.SessionID, &p.DeviceID, &p.Role, &p.Status, &p.DisplayName, &p.Platform, &p.SignedIn,
		&p.Words, &p.JoinedVia, &p.RequestReason, &p.IPHash, &p.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

func (p participantRow) view() Participant {
	v := Participant{ID: p.ID, Role: p.Role, Status: p.Status, DisplayName: p.DisplayName, Platform: p.Platform,
		SignedIn: p.SignedIn, JoinedAt: p.JoinedAt}
	if p.Words != nil {
		v.SecurityWords = strings.Fields(*p.Words)
	}
	if p.JoinedVia != nil {
		v.JoinedVia = *p.JoinedVia
	}
	if p.RequestReason != nil {
		v.RequestReason = *p.RequestReason
	}
	return v
}

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func listParticipants(ctx context.Context, q querier, sessionID string) ([]participantRow, error) {
	rows, err := q.Query(ctx, `SELECT `+participantCols+` FROM session_participants WHERE session_id = $1::uuid ORDER BY created_at, id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []participantRow
	for rows.Next() {
		p, err := scanParticipant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func listFiles(ctx context.Context, q querier, sessionID string) ([]File, int64, error) {
	rows, err := q.Query(ctx, `SELECT id::text, name, size, mime FROM shared_files WHERE session_id = $1::uuid ORDER BY position`, sessionID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []File
	var total int64
	for rows.Next() {
		var f File
		if err := rows.Scan(&f.ID, &f.Name, &f.Size, &f.Mime); err != nil {
			return nil, 0, err
		}
		total += f.Size
		out = append(out, f)
	}
	return out, total, rows.Err()
}

func capacity(ps []participantRow) Capacity {
	c := Capacity{Max: MaxReceivers}
	for _, p := range ps {
		if p.Role != "receiver" {
			continue
		}
		switch p.Status {
		case PJoined:
			c.Joined++
		case PRequested:
			c.Requested++
		}
	}
	return c
}

func senderOf(ps []participantRow) *participantRow {
	for i := range ps {
		if ps[i].Role == "sender" {
			return &ps[i]
		}
	}
	return nil
}

func (s *Service) protected() bool {
	on, _ := s.cfg.Protected.Active()
	return on
}

// ---- events ----

// SessionUpdated is the SESSION_UPDATED event (shared/protocol/websocket-events.json).
type SessionUpdated struct {
	Type            string         `json:"type"`
	SessionID       string         `json:"session_id"`
	Status          string         `json:"status"`
	RequireApproval bool           `json:"require_approval"`
	JoinWindow      JoinWindowView `json:"join_window"`
	Capacity        Capacity       `json:"capacity"`
	ServerTime      time.Time      `json:"server_time"`
}

// ParticipantEvent is PARTICIPANT_* (JOINED, REQUESTED, APPROVED, REJECTED, REMOVED, BLOCKED, LEFT).
type ParticipantEvent struct {
	Type        string      `json:"type"`
	SessionID   string      `json:"session_id"`
	Participant Participant `json:"participant"`
}

// SessionEnded is SESSION_CLOSED or SESSION_EXPIRED.
type SessionEnded struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	Reason    string `json:"reason,omitempty"`
}

// ProtectedModeEvent is PROTECTED_MODE.
type ProtectedModeEvent struct {
	Type   string    `json:"type"`
	Active bool      `json:"active"`
	Until  time.Time `json:"until"`
}

func (s *Service) notifyDevices(ids []string, v any) {
	if s.cfg.Notify == nil {
		return
	}
	for _, id := range ids {
		s.cfg.Notify.SendToDevice(id, v)
	}
}

// liveDevices are the devices that receive session-wide events: the sender and every receiver that is
// JOINED or REQUESTED.
func liveDevices(ps []participantRow) []string {
	var out []string
	for _, p := range ps {
		if p.Role == "sender" || p.Status == PJoined || p.Status == PRequested {
			out = append(out, p.DeviceID)
		}
	}
	return out
}

func (s *Service) emitSessionUpdated(ctx context.Context, sessionID string) {
	r, err := scanSession(s.cfg.Pool.QueryRow(ctx, `SELECT `+sessionCols+` FROM share_sessions WHERE id = $1::uuid`, sessionID))
	if err != nil {
		return
	}
	ps, err := listParticipants(ctx, s.cfg.Pool, sessionID)
	if err != nil {
		return
	}
	s.notifyDevices(liveDevices(ps), SessionUpdated{
		Type: "SESSION_UPDATED", SessionID: sessionID, Status: r.Status, RequireApproval: r.RequireApproval,
		JoinWindow: JoinWindowView{State: r.effectiveWindow(s.now()), OpenedAt: r.WindowOpenedAt, EndsAt: r.WindowEndsAt, Seq: r.WindowSeq},
		Capacity:   capacity(ps), ServerTime: s.now(),
	})
}

func (s *Service) logEvent(ctx context.Context, q querier, sessionID, typ string) {
	_, _ = q.Exec(ctx, `INSERT INTO session_events (session_id, type, created_at) VALUES ($1::uuid, $2, $3)`, sessionID, typ, s.now())
}
