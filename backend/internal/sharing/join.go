package sharing

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- lockouts (docs/SECURITY_MODEL.md §5: failed code lookups) ----

func (s *Service) lockedFor(c Caller) (time.Duration, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.cfg.Clock.Now()
	var wait time.Duration
	for _, k := range []string{"ip:" + c.IPKey, "dev:" + c.DeviceID} {
		if until, ok := s.lockout[k]; ok {
			if now.Before(until) {
				if d := until.Sub(now); d > wait {
					wait = d
				}
			} else {
				delete(s.lockout, k)
			}
		}
	}
	return wait, wait > 0
}

// failedLookup counts a failed code lookup per address, per device, and service-wide.
func (s *Service) failedLookup(c Caller) {
	now := s.cfg.Clock.Now()
	s.m.lookupsFailed.Inc()
	s.mu.Lock()
	if ok, _ := s.cfg.Limits.FailedIP.Allow(c.IPKey); !ok {
		if _, locked := s.lockout["ip:"+c.IPKey]; !locked {
			s.m.lockouts.Inc()
		}
		s.lockout["ip:"+c.IPKey] = now.Add(LockoutDuration)
	}
	if ok, _ := s.cfg.Limits.FailedDevice.Allow(c.DeviceID); !ok {
		if _, locked := s.lockout["dev:"+c.DeviceID]; !locked {
			s.m.lockouts.Inc()
		}
		s.lockout["dev:"+c.DeviceID] = now.Add(LockoutDuration)
	}
	s.mu.Unlock()
	if s.cfg.Protected.RecordFailure() {
		s.m.protectedOn.Inc()
		_, until := s.cfg.Protected.Active()
		s.cfg.Log.Warn("protected mode on: failed code lookups above the alarm threshold")
		if s.cfg.Notify != nil {
			s.cfg.Notify.Broadcast(ProtectedModeEvent{Type: "PROTECTED_MODE", Active: true, Until: until})
		}
	}
}

func (s *Service) isBlocked(ctx context.Context, q querier, sessionID string, c Caller) (bool, error) {
	var n int
	err := q.QueryRow(ctx, `SELECT count(*) FROM session_blocks WHERE session_id = $1::uuid AND (device_id = $2::uuid OR (ip_hash IS NOT NULL AND ip_hash = $3))`,
		sessionID, c.DeviceID, s.keys.ipHash(c.IPKey)).Scan(&n)
	return n > 0, err
}

// ResolveCode looks up a six-digit code and returns the preview with a join ticket.
func (s *Service) ResolveCode(ctx context.Context, c Caller, code string) (Preview, error) {
	code = strings.TrimSpace(code)
	if !ValidCode(code) {
		return Preview{}, ErrInvalid
	}
	if wait, locked := s.lockedFor(c); locked {
		return Preview{}, rateLimited("locked_out", wait)
	}
	if ok, wait := s.cfg.Limits.LookupIP.Allow(c.IPKey); !ok {
		return Preview{}, rateLimited("rate_limited", wait)
	}
	if ok, wait := s.cfg.Limits.LookupDevice.Allow(c.DeviceID); !ok {
		return Preview{}, rateLimited("rate_limited", wait)
	}
	h := s.keys.codeHMAC(code)
	// Prefer the open window holding this code; otherwise the most recent session that used it.
	r, err := scanSession(s.cfg.Pool.QueryRow(ctx, `SELECT `+sessionCols+` FROM share_sessions WHERE code_hmac = $1
		ORDER BY (join_window_state = 'OPEN') DESC, join_window_opened_at DESC LIMIT 1`, h))
	if errors.Is(err, ErrNotFound) {
		s.failedLookup(c)
		return Preview{}, errf(404, "code_not_found", "Code not found. Check the 6 digits.")
	}
	if err != nil {
		return Preview{}, err
	}
	if r.effectiveWindow(s.now()) != WindowOpen || !r.live() {
		// A code whose window ended counts as a failed lookup (docs/API.md §2.2).
		s.failedLookup(c)
		if !r.live() {
			return Preview{}, ErrSessionExpired
		}
		return Preview{}, windowError(r.effectiveWindow(s.now()))
	}
	return s.preview(ctx, c, r, "code")
}

// ResolveLink looks up a link or QR token and returns the preview with a join ticket.
func (s *Service) ResolveLink(ctx context.Context, c Caller, token string) (Preview, error) {
	token = strings.TrimSpace(token)
	if !ValidToken(token) {
		return Preview{}, ErrInvalid
	}
	if ok, wait := s.cfg.Limits.LinkIP.Allow(c.IPKey); !ok {
		return Preview{}, rateLimited("rate_limited", wait)
	}
	if ok, wait := s.cfg.Limits.LinkDevice.Allow(c.DeviceID); !ok {
		return Preview{}, rateLimited("rate_limited", wait)
	}
	var sessionID string
	var seq int
	var expires time.Time
	var revoked *time.Time
	err := s.cfg.Pool.QueryRow(ctx, `SELECT session_id::text, window_seq, expires_at, revoked_at FROM capability_tokens
		WHERE token_hash = $1 AND purpose = 'join'`, hashToken(token)).Scan(&sessionID, &seq, &expires, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preview{}, errf(404, "link_not_found", "This link isn't valid.")
	}
	if err != nil {
		return Preview{}, err
	}
	r, err := scanSession(s.cfg.Pool.QueryRow(ctx, `SELECT `+sessionCols+` FROM share_sessions WHERE id = $1::uuid`, sessionID))
	if err != nil {
		return Preview{}, err
	}
	if !r.live() {
		return Preview{}, ErrSessionExpired
	}
	if seq != r.WindowSeq {
		return Preview{}, ErrWindowExpired // replaced by Create new code
	}
	if st := r.effectiveWindow(s.now()); st != WindowOpen {
		return Preview{}, windowError(st) // full, not accepting, or expired
	}
	if revoked != nil || !s.now().Before(expires) {
		return Preview{}, ErrWindowExpired
	}
	return s.preview(ctx, c, r, "link")
}

func (s *Service) preview(ctx context.Context, c Caller, r sessionRow, via string) (Preview, error) {
	if blocked, err := s.isBlocked(ctx, s.cfg.Pool, r.ID, c); err != nil {
		return Preview{}, err
	} else if blocked {
		return Preview{}, ErrBlocked
	}
	ps, err := listParticipants(ctx, s.cfg.Pool, r.ID)
	if err != nil {
		return Preview{}, err
	}
	snd := senderOf(ps)
	if snd == nil {
		return Preview{}, ErrNotFound
	}
	if snd.DeviceID == c.DeviceID {
		return Preview{}, errf(409, "own_session", "This is your own session.")
	}
	files, total, err := listFiles(ctx, s.cfg.Pool, r.ID)
	if err != nil {
		return Preview{}, err
	}
	now := s.now()
	exp := now.Add(JoinTicketTTL)
	if r.WindowEndsAt.Before(exp) {
		exp = r.WindowEndsAt // a ticket never outlives the join window
	}
	ticket, h := newToken()
	if _, err := s.cfg.Pool.Exec(ctx, `INSERT INTO capability_tokens (token_hash, session_id, purpose, window_seq, via, device_id, created_at, expires_at)
		VALUES ($1, $2::uuid, 'join_ticket', $3, $4, $5::uuid, $6, $7)`, h, r.ID, r.WindowSeq, via, c.DeviceID, now, exp); err != nil {
		return Preview{}, err
	}
	p := Preview{SessionID: r.ID, Sender: &PeerSummary{ParticipantID: snd.ID, DisplayName: snd.DisplayName, Platform: snd.Platform, SignedIn: snd.SignedIn},
		Files: files, TotalBytes: total, FileCount: len(files), RequireApproval: r.RequireApproval,
		ProtectedMode: s.protected() && via == "code", JoinWindowEndsAt: r.WindowEndsAt, JoinTicket: ticket, TicketExpiresAt: exp,
		Via: via, ServerTime: now}
	for _, x := range ps {
		if x.DeviceID == c.DeviceID {
			p.Existing = x.Status
		}
	}
	return p, nil
}

// JoinResult is POST /v1/sessions/{id}/join.
type JoinResult struct {
	SessionID   string      `json:"session_id"`
	Participant Participant `json:"participant"`
	ServerTime  time.Time   `json:"server_time"`
}

// Join admits the caller with a join ticket: JOINED in open-join sessions, REQUESTED when approval is on or
// protected mode applies to a code join. The five-receiver cap is enforced under a row lock.
func (s *Service) Join(ctx context.Context, c Caller, sessionID, ticket string) (JoinResult, error) {
	if !ValidID(sessionID) || !ValidToken(ticket) {
		return JoinResult{}, ErrInvalid
	}
	if ok, wait := s.cfg.Limits.Join.Allow(c.DeviceID); !ok {
		return JoinResult{}, rateLimited("rate_limited", wait)
	}
	if ok, wait := s.cfg.Limits.JoinIP.Allow(c.IPKey); !ok {
		return JoinResult{}, rateLimited("rate_limited", wait)
	}
	now := s.now()
	var out participantRow
	var event string
	windowChanged := false
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		r, err := lockSession(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		var seq int
		var via string
		var expires time.Time
		var used, revoked *time.Time
		var dev *string
		err = tx.QueryRow(ctx, `SELECT window_seq, via, expires_at, used_at, revoked_at, device_id::text FROM capability_tokens
			WHERE token_hash = $1 AND purpose = 'join_ticket' AND session_id = $2::uuid FOR UPDATE`, hashToken(ticket), sessionID).
			Scan(&seq, &via, &expires, &used, &revoked, &dev)
		if errors.Is(err, pgx.ErrNoRows) {
			return errf(410, "join_ticket_invalid", "Open the code or link again.")
		}
		if err != nil {
			return err
		}
		if dev == nil || *dev != c.DeviceID || used != nil || revoked != nil {
			return errf(410, "join_ticket_invalid", "Open the code or link again.")
		}
		if !r.live() {
			return ErrSessionExpired
		}
		existing, perr := participantFor(ctx, tx, sessionID, c.DeviceID)
		if perr == nil && (existing.Status == PJoined || existing.Status == PRequested) {
			out = existing // idempotent: already in
			_, err := tx.Exec(ctx, `UPDATE capability_tokens SET used_at = $2 WHERE token_hash = $1`, hashToken(ticket), now)
			return err
		}
		if seq != r.WindowSeq || !now.Before(expires) {
			return ErrWindowExpired
		}
		if st := r.effectiveWindow(now); st != WindowOpen {
			return windowError(st)
		}
		if blocked, err := s.isBlocked(ctx, tx, sessionID, c); err != nil {
			return err
		} else if blocked {
			return ErrBlocked
		}
		ps, err := listParticipants(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		cp := capacity(ps)
		if cp.Joined+cp.Requested >= MaxReceivers {
			return ErrSessionFull
		}
		status, reason := PJoined, ""
		switch {
		case r.RequireApproval:
			status, reason = PRequested, "approval"
		case via == "code" && s.protected():
			status, reason = PRequested, "protected_mode"
		}
		words := strings.Join(s.keys.securityWords(sessionID, c.DeviceID), " ")
		var joinedAt *time.Time
		if status == PJoined {
			joinedAt = &now
		}
		var reasonPtr *string
		if reason != "" {
			reasonPtr = &reason
		}
		id := newID()
		if perr == nil {
			id = existing.ID // a removed, left or rejected receiver may join again with a new ticket
		}
		out, err = scanParticipant(tx.QueryRow(ctx, `INSERT INTO session_participants
			(id, session_id, device_id, role, status, display_name, platform, signed_in, security_words, joined_via, request_reason, ip_hash, created_at, joined_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, 'receiver', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			ON CONFLICT (session_id, device_id) DO UPDATE SET status = EXCLUDED.status, display_name = EXCLUDED.display_name,
				platform = EXCLUDED.platform, signed_in = EXCLUDED.signed_in, security_words = EXCLUDED.security_words,
				joined_via = EXCLUDED.joined_via, request_reason = EXCLUDED.request_reason, ip_hash = EXCLUDED.ip_hash,
				joined_at = EXCLUDED.joined_at, decided_at = NULL
			RETURNING `+participantCols,
			id, sessionID, c.DeviceID, status, c.DisplayName, c.Platform, c.SignedIn, words, via, reasonPtr, nullable(s.keys.ipHash(c.IPKey)), now, joinedAt))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE capability_tokens SET used_at = $2 WHERE token_hash = $1`, hashToken(ticket), now); err != nil {
			return err
		}
		if cp.Joined+cp.Requested+1 >= MaxReceivers {
			if _, err := tx.Exec(ctx, `UPDATE share_sessions SET join_window_state = 'ENDED_FULL' WHERE id = $1::uuid`, sessionID); err != nil {
				return err
			}
			windowChanged = true
		}
		if status == PJoined {
			if err := activate(ctx, tx, sessionID, out.ID, now); err != nil {
				return err
			}
			windowChanged = true
			event = "PARTICIPANT_JOINED"
		} else {
			event = "PARTICIPANT_REQUESTED"
		}
		s.logEvent(ctx, tx, sessionID, event)
		return nil
	})
	if windowChanged {
		defer s.emitSessionUpdated(context.WithoutCancel(ctx), sessionID)
	}
	if err != nil {
		return JoinResult{}, err
	}
	switch event {
	case "PARTICIPANT_JOINED":
		s.m.joins.Inc()
	case "PARTICIPANT_REQUESTED":
		s.m.requests.Inc()
	}
	if event != "" {
		s.notifySender(ctx, sessionID, ParticipantEvent{Type: event, SessionID: sessionID, Participant: out.view()})
	}
	return JoinResult{SessionID: sessionID, Participant: out.view(), ServerTime: now}, nil
}

// activate marks the session ACTIVE and creates PENDING transfer records for a newly joined receiver.
func activate(ctx context.Context, tx pgx.Tx, sessionID, participantID string, now time.Time) error {
	if _, err := tx.Exec(ctx, `UPDATE share_sessions SET status = 'ACTIVE', last_activity_at = $2 WHERE id = $1::uuid AND status = 'WAITING'`, sessionID, now); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO transfers (id, session_id, participant_id, file_id, status, updated_at)
		SELECT gen_random_uuid(), $1::uuid, $2::uuid, f.id, 'PENDING', $3 FROM shared_files f WHERE f.session_id = $1::uuid
		ON CONFLICT (participant_id, file_id) DO NOTHING`, sessionID, participantID, now)
	return err
}

func (s *Service) notifySender(ctx context.Context, sessionID string, v any) {
	var dev string
	if err := s.cfg.Pool.QueryRow(ctx, `SELECT device_id::text FROM session_participants WHERE session_id = $1::uuid AND role = 'sender'`, sessionID).Scan(&dev); err == nil {
		s.notifyDevices([]string{dev}, v)
	}
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
