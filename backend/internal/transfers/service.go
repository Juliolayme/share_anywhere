package transfers

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/metrics"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// Sessions answers membership questions (implemented by sharing.Service).
type Sessions interface {
	Member(ctx context.Context, deviceID, sessionID string) (sharing.Member, error)
	Peers(ctx context.Context, sessionID string) ([]sharing.Peer, error)
}

// Notifier delivers WebSocket events (implemented by the ws hub).
type Notifier interface {
	SendToDevice(deviceID string, v any) bool
}

// Config wires the service.
type Config struct {
	Pool     *pgxpool.Pool
	Clock    clock.Clock
	Sessions Sessions
	Notify   Notifier
	Metrics  *metrics.Registry
	// ReportLimit bounds report calls per device (progress is throttled by clients; this stops floods).
	ReportLimit *ratelimit.Limiter
}

type counters struct {
	completed, failed, cancelled, resumed, direct, relay, cloud, bytes *metrics.Counter
}

// Service implements transfer records.
type Service struct {
	cfg Config
	m   counters
}

// New returns the service.
func New(cfg Config) *Service {
	r := cfg.Metrics
	if r == nil {
		r = metrics.New()
	}
	return &Service{cfg: cfg, m: counters{
		completed: r.Counter("sa_transfers_completed_total", "Transfers (file × receiver) completed and verified."),
		failed:    r.Counter("sa_transfers_failed_total", "Transfers that failed."),
		cancelled: r.Counter("sa_transfers_cancelled_total", "Transfers cancelled by a participant or by session end."),
		resumed:   r.Counter("sa_transfer_resumes_total", "Transfers that entered RESUMING (reconnect or resume after pause)."),
		direct:    r.Counter("sa_transfer_route_direct_total", "Completed transfers whose last reported route was direct."),
		relay:     r.Counter("sa_transfer_route_relay_total", "Completed transfers whose last reported route was TURN relay."),
		cloud:     r.Counter("sa_transfer_route_cloud_total", "Completed transfers whose last reported route was Cloud."),
		bytes:     r.Counter("sa_transfer_verified_bytes_total", "Bytes of completed transfers (verified by receivers)."),
	}}
}

func (s *Service) now() time.Time { return s.cfg.Clock.Now().UTC() }

const cols = `t.id::text, t.session_id::text, t.participant_id::text, t.file_id::text, t.status, t.verified_bytes, f.size, t.route, t.updated_at`

func scan(row pgx.Row) (Transfer, error) {
	var t Transfer
	err := row.Scan(&t.ID, &t.SessionID, &t.ParticipantID, &t.FileID, &t.Status, &t.VerifiedBytes, &t.Size, &t.Route, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, errNotFound
	}
	return t, err
}

// List returns the transfers the caller may see in a session.
func (s *Service) List(ctx context.Context, deviceID, sessionID string) (List, error) {
	m, err := s.cfg.Sessions.Member(ctx, deviceID, sessionID)
	if err != nil {
		return List{}, err
	}
	out := List{Role: m.Role, Transfers: []Transfer{}, ServerTime: s.now()}
	q := `SELECT ` + cols + ` FROM transfers t JOIN shared_files f ON f.id = t.file_id WHERE t.session_id = $1::uuid`
	args := []any{sessionID}
	switch {
	case m.Role == "sender":
		peers, err := s.cfg.Sessions.Peers(ctx, sessionID)
		if err != nil {
			return List{}, err
		}
		out.Peers = peers
	case m.Status == sharing.PJoined:
		q += ` AND t.participant_id = $2::uuid`
		args = append(args, m.ParticipantID)
		out.Capability = m.Capability
	default:
		return List{}, errNotFound // file metadata and transfers need JOINED (docs/API.md §1)
	}
	rows, err := s.cfg.Pool.Query(ctx, q+` ORDER BY f.position, t.participant_id`, args...)
	if err != nil {
		return List{}, err
	}
	defer rows.Close()
	for rows.Next() {
		t, err := scan(rows)
		if err != nil {
			return List{}, err
		}
		out.Transfers = append(out.Transfers, t)
	}
	return out, rows.Err()
}

// Files lists the session's files for the sender or a JOINED receiver.
func (s *Service) Files(ctx context.Context, deviceID, sessionID string) ([]sharing.File, error) {
	m, err := s.cfg.Sessions.Member(ctx, deviceID, sessionID)
	if err != nil {
		return nil, err
	}
	if m.Role == "receiver" && m.Status != sharing.PJoined {
		return nil, errNotFound
	}
	rows, err := s.cfg.Pool.Query(ctx, `SELECT id::text, name, size, mime FROM shared_files WHERE session_id = $1::uuid ORDER BY position`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []sharing.File{}
	for rows.Next() {
		var f sharing.File
		if err := rows.Scan(&f.ID, &f.Name, &f.Size, &f.Mime); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// access loads a transfer and checks the caller is its sender or its JOINED receiver.
func (s *Service) access(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, deviceID, transferID string, lock bool) (Transfer, sharing.Member, error) {
	if !sharing.ValidID(transferID) {
		return Transfer{}, sharing.Member{}, errNotFound
	}
	sql := `SELECT ` + cols + ` FROM transfers t JOIN shared_files f ON f.id = t.file_id WHERE t.id = $1::uuid`
	if lock {
		sql += ` FOR UPDATE OF t`
	}
	t, err := scan(q.QueryRow(ctx, sql, transferID))
	if err != nil {
		return t, sharing.Member{}, err
	}
	m, err := s.cfg.Sessions.Member(ctx, deviceID, t.SessionID)
	if err != nil {
		return t, m, errNotFound
	}
	if m.Role == "receiver" && (m.Status != sharing.PJoined || m.ParticipantID != t.ParticipantID) {
		return t, m, errNotFound // other receivers' transfers do not exist for this caller
	}
	return t, m, nil
}

// Get returns one transfer.
func (s *Service) Get(ctx context.Context, deviceID, transferID string) (Transfer, error) {
	t, _, err := s.access(ctx, s.cfg.Pool, deviceID, transferID, false)
	return t, err
}

// Report records state, verified bytes and route from a participant's engine.
func (s *Service) Report(ctx context.Context, deviceID, transferID string, r Report) (Transfer, error) {
	if !known(r.Status) {
		return Transfer{}, errStatus
	}
	if r.Route != nil && !Routes[*r.Route] {
		return Transfer{}, errRoute
	}
	if s.cfg.ReportLimit != nil {
		if ok, wait := s.cfg.ReportLimit.Allow("dev:" + deviceID); !ok {
			return Transfer{}, &Error{Status: 429, Code: "rate_limited", Msg: "Too many transfer reports.", Wait: wait}
		}
	}
	return s.move(ctx, deviceID, transferID, func(t Transfer, m sharing.Member) (Transfer, error) {
		if r.VerifiedBytes < t.VerifiedBytes || r.VerifiedBytes > t.Size {
			if !Terminal(t.Status) || t.Status != r.Status {
				return t, errBytes
			}
		}
		if r.Status == Completed && (m.Role != "receiver" || r.VerifiedBytes != t.Size) {
			return t, errComplete
		}
		t.Status, t.VerifiedBytes = r.Status, max(r.VerifiedBytes, t.VerifiedBytes)
		if r.Route != nil {
			t.Route = r.Route
		}
		return t, nil
	})
}

// Action is a participant control: pause, resume or cancel. A receiver resuming must present its transfer
// capability (docs/API.md §2.3).
func (s *Service) Action(ctx context.Context, deviceID, transferID, action, capability string) (Transfer, error) {
	return s.move(ctx, deviceID, transferID, func(t Transfer, m sharing.Member) (Transfer, error) {
		switch action {
		case "pause":
			t.Status = Paused
		case "resume":
			if m.Role == "receiver" && subtle.ConstantTimeCompare([]byte(capability), []byte(m.Capability)) != 1 {
				return t, errCapability
			}
			if t.Status != Paused {
				return t, errTransition
			}
			t.Status = Resuming
		case "cancel":
			t.Status = Cancelled
		default:
			return t, errNotFound
		}
		return t, nil
	})
}

// move applies change under a row lock, validates the transition, stores it, notifies both sides and counts.
func (s *Service) move(ctx context.Context, deviceID, transferID string, change func(Transfer, sharing.Member) (Transfer, error)) (Transfer, error) {
	tx, err := s.cfg.Pool.Begin(ctx)
	if err != nil {
		return Transfer{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cur, m, err := s.access(ctx, tx, deviceID, transferID, true)
	if err != nil {
		return Transfer{}, err
	}
	if !m.Live() && !Terminal(cur.Status) {
		return Transfer{}, errEnded
	}
	upd, err := change(cur, m)
	if err != nil {
		return Transfer{}, err
	}
	if Terminal(cur.Status) {
		if upd.Status == cur.Status {
			return cur, nil // idempotent
		}
		return Transfer{}, errTransition
	}
	if !CanMove(cur.Status, upd.Status) {
		return Transfer{}, errTransition
	}
	upd.UpdatedAt = s.now()
	if _, err := tx.Exec(ctx, `UPDATE transfers SET status = $2, verified_bytes = $3, route = $4, updated_at = $5 WHERE id = $1::uuid`,
		upd.ID, upd.Status, upd.VerifiedBytes, upd.Route, upd.UpdatedAt); err != nil {
		return Transfer{}, err
	}
	if upd.Status != cur.Status {
		if _, err := tx.Exec(ctx, `INSERT INTO session_events (session_id, type, data, created_at) VALUES ($1::uuid, 'TRANSFER_'||$2, jsonb_build_object('transfer_id', $3::text), $4)`,
			upd.SessionID, upd.Status, upd.ID, upd.UpdatedAt); err != nil {
			return Transfer{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE share_sessions SET last_activity_at = $2 WHERE id = $1::uuid`, upd.SessionID, upd.UpdatedAt); err != nil {
		return Transfer{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Transfer{}, err
	}
	if upd.Status != cur.Status {
		s.count(upd)
	}
	s.notify(ctx, upd)
	return upd, nil
}

func (s *Service) count(t Transfer) {
	switch t.Status {
	case Completed:
		s.m.completed.Inc()
		s.m.bytes.Add(t.VerifiedBytes)
		if t.Route != nil {
			map[string]*metrics.Counter{"direct": s.m.direct, "relay": s.m.relay, "cloud": s.m.cloud}[*t.Route].Inc()
		}
	case Failed:
		s.m.failed.Inc()
	case Cancelled:
		s.m.cancelled.Inc()
	case Resuming:
		s.m.resumed.Inc()
	}
}

// notify sends TRANSFER_UPDATED to the sender and to the receiver of the transfer.
func (s *Service) notify(ctx context.Context, t Transfer) {
	rows, err := s.cfg.Pool.Query(ctx, `SELECT device_id::text FROM session_participants
		WHERE session_id = $1::uuid AND (role = 'sender' OR id = $2::uuid)`, t.SessionID, t.ParticipantID)
	if err != nil {
		return
	}
	defer rows.Close()
	ev := Event{Type: "TRANSFER_UPDATED", SessionID: t.SessionID, Transfer: t}
	for rows.Next() {
		var dev string
		if rows.Scan(&dev) == nil {
			s.cfg.Notify.SendToDevice(dev, ev)
		}
	}
}

func known(s string) bool {
	switch s {
	case Pending, Connecting, Transferring, Paused, Disconnected, Reconnecting, Resuming, Completed, Failed, Cancelled:
		return true
	}
	return false
}
