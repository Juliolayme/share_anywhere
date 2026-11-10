package sharing

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// participantFor returns the caller's participant row in a session (ErrNotFound hides existence).
func participantFor(ctx context.Context, q querier, sessionID, deviceID string) (participantRow, error) {
	return scanParticipant(q.QueryRow(ctx,
		`SELECT `+participantCols+` FROM session_participants WHERE session_id = $1::uuid AND device_id = $2::uuid`, sessionID, deviceID))
}

// View returns the session as the calling device may see it (docs/API.md §1 "participant").
func (s *Service) View(ctx context.Context, deviceID, sessionID string) (SessionView, error) {
	if !ValidID(sessionID) {
		return SessionView{}, ErrNotFound
	}
	me, err := participantFor(ctx, s.cfg.Pool, sessionID, deviceID)
	if err != nil {
		return SessionView{}, err
	}
	r, err := scanSession(s.cfg.Pool.QueryRow(ctx, `SELECT `+sessionCols+` FROM share_sessions WHERE id = $1::uuid`, sessionID))
	if err != nil {
		return SessionView{}, err
	}
	now := s.now()
	v := SessionView{ID: r.ID, Role: me.Role, Status: r.Status, RequireApproval: r.RequireApproval,
		ProtectedMode: s.protected(), ExpiresAt: r.ExpiresAt, ServerTime: now}
	mv := me.view()
	v.Me = &mv
	// Receivers that left or were removed, rejected or blocked see only their own status.
	if me.Role == "receiver" && me.Status != PJoined && me.Status != PRequested {
		return v, nil
	}
	ps, err := listParticipants(ctx, s.cfg.Pool, sessionID)
	if err != nil {
		return SessionView{}, err
	}
	files, total, err := listFiles(ctx, s.cfg.Pool, sessionID)
	if err != nil {
		return SessionView{}, err
	}
	v.Files, v.TotalBytes, v.FileCount = files, total, len(files)
	if snd := senderOf(ps); snd != nil && me.Role == "receiver" {
		v.Sender = &PeerSummary{ParticipantID: snd.ID, DisplayName: snd.DisplayName, Platform: snd.Platform, SignedIn: snd.SignedIn}
	}
	if me.Role != "sender" {
		return v, nil
	}
	cp := capacity(ps)
	v.Capacity = &cp
	v.JoinWindow = &JoinWindowView{State: r.effectiveWindow(now), OpenedAt: r.WindowOpenedAt, EndsAt: r.WindowEndsAt, Seq: r.WindowSeq}
	if v.JoinWindow.State == WindowOpen {
		// Only the sender sees the code and link, and only while they can admit someone.
		if code, err := s.keys.open(r.CodeEnc); err == nil {
			v.Code = code
		}
		if tok, err := s.keys.open(r.LinkEnc); err == nil {
			v.LinkToken = tok
			v.JoinURL = s.joinURL(tok)
		}
	}
	for _, p := range ps {
		if p.Role == "receiver" {
			v.Participants = append(v.Participants, p.view())
		}
	}
	return v, nil
}

// lockSession loads and locks the session row inside a transaction.
func lockSession(ctx context.Context, tx pgx.Tx, sessionID string) (sessionRow, error) {
	return scanSession(tx.QueryRow(ctx, `SELECT `+sessionCols+` FROM share_sessions WHERE id = $1::uuid FOR UPDATE`, sessionID))
}

// requireSender loads the session for an action only its sender may take.
func requireSender(ctx context.Context, tx pgx.Tx, sessionID, deviceID string) (sessionRow, error) {
	r, err := lockSession(ctx, tx, sessionID)
	if err != nil {
		return r, err
	}
	me, err := participantFor(ctx, tx, sessionID, deviceID)
	if errors.Is(err, ErrNotFound) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	if me.Role != "sender" {
		return r, ErrForbidden
	}
	return r, nil
}

// MaxListedOpenSessions bounds ListOpen. The open-session cap (GuestOpenSessions, AcctOpenSessions) keeps the
// real number far lower; the bound only protects the query.
const MaxListedOpenSessions = 20

// OpenSession is one live session in GET /v1/sessions: what the sender needs to recognize it and decide
// whether to open or close it. It never carries the code or link (open the session for those).
type OpenSession struct {
	ID         string         `json:"id"`
	Status     string         `json:"status"`
	CreatedAt  time.Time      `json:"created_at"`
	ExpiresAt  time.Time      `json:"expires_at"`
	FileCount  int            `json:"file_count"`
	TotalBytes int64          `json:"total_bytes"`
	FirstFile  string         `json:"first_file_name"`
	Capacity   Capacity       `json:"capacity"`
	JoinWindow JoinWindowView `json:"join_window"`
}

// OpenSessionList is GET /v1/sessions.
type OpenSessionList struct {
	Sessions   []OpenSession `json:"sessions"`
	MaxOpen    int           `json:"max_open"`
	ServerTime time.Time     `json:"server_time"`
}

// ListOpen returns the live sessions the calling device owns as sender, newest first: exactly the sessions the
// open-session cap in Create counts, so a sender refused with too_many_open_sessions can find and close one.
func (s *Service) ListOpen(ctx context.Context, deviceID string, signedIn bool) (OpenSessionList, error) {
	now := s.now()
	out := OpenSessionList{Sessions: []OpenSession{}, MaxOpen: GuestOpenSessions, ServerTime: now}
	if signedIn {
		out.MaxOpen = AcctOpenSessions
	}
	rows, err := s.cfg.Pool.Query(ctx, `SELECT s.id::text, s.status, s.created_at, s.expires_at,
			s.join_window_state, s.join_window_opened_at, s.join_window_ends_at, s.join_window_seq,
			f.n, f.total, COALESCE(f.first, ''),
			p.joined, p.requested
		FROM share_sessions s
		CROSS JOIN LATERAL (
			SELECT count(*)::int AS n, COALESCE(sum(size), 0)::bigint AS total,
				(array_agg(name ORDER BY position))[1] AS first
			FROM shared_files WHERE session_id = s.id) f
		CROSS JOIN LATERAL (
			SELECT count(*) FILTER (WHERE status = 'JOINED')::int AS joined,
				count(*) FILTER (WHERE status = 'REQUESTED')::int AS requested
			FROM session_participants WHERE session_id = s.id AND role = 'receiver') p
		WHERE s.owner_device_id = $1::uuid AND s.status IN ('WAITING','ACTIVE') AND s.expires_at > $2
		ORDER BY s.created_at DESC, s.id DESC
		LIMIT $3`, deviceID, now, MaxListedOpenSessions)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var o OpenSession
		var r sessionRow
		if err := rows.Scan(&o.ID, &o.Status, &o.CreatedAt, &o.ExpiresAt,
			&r.WindowState, &r.WindowOpenedAt, &r.WindowEndsAt, &r.WindowSeq,
			&o.FileCount, &o.TotalBytes, &o.FirstFile, &o.Capacity.Joined, &o.Capacity.Requested); err != nil {
			return out, err
		}
		o.Capacity.Max = MaxReceivers
		o.JoinWindow = JoinWindowView{State: r.effectiveWindow(now), OpenedAt: r.WindowOpenedAt, EndsAt: r.WindowEndsAt, Seq: r.WindowSeq}
		out.Sessions = append(out.Sessions, o)
	}
	return out, rows.Err()
}
