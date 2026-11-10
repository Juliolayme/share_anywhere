package sharing

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// participantAction loads a participant and its session for an action, under the session row lock.
func (s *Service) participantAction(ctx context.Context, tx pgx.Tx, participantID string) (participantRow, sessionRow, error) {
	if !ValidID(participantID) {
		return participantRow{}, sessionRow{}, ErrNotFound
	}
	var sessionID string
	if err := tx.QueryRow(ctx, `SELECT session_id::text FROM session_participants WHERE id = $1::uuid`, participantID).Scan(&sessionID); err != nil {
		return participantRow{}, sessionRow{}, ErrNotFound
	}
	r, err := lockSession(ctx, tx, sessionID)
	if err != nil {
		return participantRow{}, r, err
	}
	p, err := scanParticipant(tx.QueryRow(ctx, `SELECT `+participantCols+` FROM session_participants WHERE id = $1::uuid FOR UPDATE`, participantID))
	return p, r, err
}

// Decide applies a sender action to a receiver: approve, reject, remove, or block (docs/ARCHITECTURE.md §4.4).
func (s *Service) Decide(ctx context.Context, c Caller, participantID, action string) (Participant, error) {
	now := s.now()
	var out participantRow
	var deviceToNotify, event string
	windowChanged := false
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		p, r, err := s.participantAction(ctx, tx, participantID)
		if err != nil {
			return err
		}
		if _, err := requireSender(ctx, tx, r.ID, c.DeviceID); err != nil {
			return err
		}
		if p.Role != "receiver" {
			return ErrConflict
		}
		var next string
		switch action {
		case "approve":
			if p.Status != PRequested {
				return ErrConflict
			}
			if !r.live() {
				return ErrSessionExpired
			}
			next, event = PJoined, "PARTICIPANT_APPROVED"
		case "reject":
			if p.Status != PRequested {
				return ErrConflict
			}
			next, event = PRejected, "PARTICIPANT_REJECTED"
		case "remove":
			if p.Status != PJoined && p.Status != PRequested {
				return ErrConflict
			}
			next, event = PRemoved, "PARTICIPANT_REMOVED"
		case "block":
			if p.Status == PBlocked {
				return ErrConflict
			}
			next, event = PBlocked, "PARTICIPANT_BLOCKED"
			ip := ""
			if p.IPKey != nil {
				ip = *p.IPKey
			}
			if _, err := tx.Exec(ctx, `INSERT INTO session_blocks (session_id, device_id, ip_key, created_at) VALUES ($1::uuid, $2::uuid, NULLIF($3, ''), $4)`,
				r.ID, p.DeviceID, ip, now); err != nil {
				return err
			}
		default:
			return ErrInvalid
		}
		joinedAt := p.JoinedAt
		if next == PJoined {
			joinedAt = &now
		}
		out, err = scanParticipant(tx.QueryRow(ctx, `UPDATE session_participants SET status = $2, decided_at = $3, joined_at = $4
			WHERE id = $1::uuid RETURNING `+participantCols, p.ID, next, now, joinedAt))
		if err != nil {
			return err
		}
		if next == PJoined {
			if err := activate(ctx, tx, r.ID, p.ID, now); err != nil {
				return err
			}
		}
		if next != PJoined {
			// Removed, rejected and blocked receivers lose every capability at once.
			if _, err := tx.Exec(ctx, `UPDATE capability_tokens SET revoked_at = $2 WHERE participant_id = $1::uuid AND revoked_at IS NULL`, p.ID, now); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE transfers SET status = 'CANCELLED', updated_at = $2 WHERE participant_id = $1::uuid AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`, p.ID, now); err != nil {
				return err
			}
		}
		windowChanged = true
		deviceToNotify = p.DeviceID
		s.logEvent(ctx, tx, r.ID, event)
		return nil
	})
	if err != nil {
		return Participant{}, err
	}
	ev := ParticipantEvent{Type: event, SessionID: out.SessionID, Participant: out.view()}
	s.notifySender(ctx, out.SessionID, ev)
	s.notifyDevices([]string{deviceToNotify}, ev)
	if windowChanged {
		s.emitSessionUpdated(ctx, out.SessionID)
	}
	return out.view(), nil
}

// Leave lets a receiver leave a session.
func (s *Service) Leave(ctx context.Context, c Caller, participantID string) (Participant, error) {
	now := s.now()
	var out participantRow
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		p, _, err := s.participantAction(ctx, tx, participantID)
		if err != nil {
			return err
		}
		if p.DeviceID != c.DeviceID {
			return ErrNotFound
		}
		if p.Role != "receiver" || (p.Status != PJoined && p.Status != PRequested) {
			return ErrConflict
		}
		out, err = scanParticipant(tx.QueryRow(ctx, `UPDATE session_participants SET status = 'LEFT', decided_at = $2 WHERE id = $1::uuid RETURNING `+participantCols, p.ID, now))
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE transfers SET status = 'CANCELLED', updated_at = $2 WHERE participant_id = $1::uuid AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`, p.ID, now)
		return err
	})
	if err != nil {
		return Participant{}, err
	}
	s.notifySender(ctx, out.SessionID, ParticipantEvent{Type: "PARTICIPANT_LEFT", SessionID: out.SessionID, Participant: out.view()})
	s.emitSessionUpdated(ctx, out.SessionID)
	return out.view(), nil
}

// UpdateInput is PATCH /v1/sessions/{id}.
type UpdateInput struct {
	RequireApproval    *bool `json:"require_approval,omitempty"`
	AcceptingReceivers *bool `json:"accepting_receivers,omitempty"`
}

// Update toggles Require approval (future joins only) and Stop accepting (ends the join window now).
func (s *Service) Update(ctx context.Context, c Caller, sessionID string, in UpdateInput) (SessionView, error) {
	if !ValidID(sessionID) {
		return SessionView{}, ErrNotFound
	}
	if in.RequireApproval == nil && in.AcceptingReceivers == nil {
		return SessionView{}, ErrInvalid
	}
	if in.AcceptingReceivers != nil && *in.AcceptingReceivers {
		return SessionView{}, errf(400, "invalid_request", "Use Create new code to accept receivers again.")
	}
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		r, err := requireSender(ctx, tx, sessionID, c.DeviceID)
		if err != nil {
			return err
		}
		if !r.live() {
			return ErrSessionExpired
		}
		if in.RequireApproval != nil {
			if _, err := tx.Exec(ctx, `UPDATE share_sessions SET require_approval = $2 WHERE id = $1::uuid`, sessionID, *in.RequireApproval); err != nil {
				return err
			}
		}
		if in.AcceptingReceivers != nil {
			if _, err := tx.Exec(ctx, `UPDATE share_sessions SET join_window_state = 'ENDED_BY_SENDER' WHERE id = $1::uuid AND join_window_state = 'OPEN'`, sessionID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE capability_tokens SET revoked_at = $2 WHERE session_id = $1::uuid AND purpose IN ('join','join_ticket') AND revoked_at IS NULL`, sessionID, s.now()); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return SessionView{}, err
	}
	s.emitSessionUpdated(ctx, sessionID)
	return s.View(ctx, c.DeviceID, sessionID)
}

// Renew is Create new code: a new code, link and QR with a fresh 10-minute window; old ones stop working.
func (s *Service) Renew(ctx context.Context, c Caller, sessionID string) (SessionView, error) {
	if !ValidID(sessionID) {
		return SessionView{}, ErrNotFound
	}
	if ok, wait := s.cfg.Limits.Renew.Allow(c.DeviceID); !ok {
		return SessionView{}, rateLimited("rate_limited", wait)
	}
	now := s.now()
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		r, err := requireSender(ctx, tx, sessionID, c.DeviceID)
		if err != nil {
			return err
		}
		if !r.live() {
			return ErrSessionExpired
		}
		ps, err := listParticipants(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		if cp := capacity(ps); cp.Joined+cp.Requested >= MaxReceivers {
			return ErrSessionFull
		}
		if _, err := tx.Exec(ctx, `UPDATE capability_tokens SET revoked_at = $2 WHERE session_id = $1::uuid AND purpose IN ('join','join_ticket') AND revoked_at IS NULL`, sessionID, now); err != nil {
			return err
		}
		// Close the current window first so the new code's uniqueness check ignores this session's old code.
		if _, err := tx.Exec(ctx, `UPDATE share_sessions SET join_window_state = 'EXPIRED' WHERE id = $1::uuid AND join_window_state = 'OPEN'`, sessionID); err != nil {
			return err
		}
		linkToken, linkHash := newToken()
		for attempt := 0; ; attempt++ {
			if attempt == 8 {
				return errf(503, "unavailable", "Try again.")
			}
			code := newCode()
			err := pgx.BeginFunc(ctx, tx, func(sp pgx.Tx) error {
				_, err := sp.Exec(ctx, `UPDATE share_sessions SET join_window_state = 'OPEN', join_window_seq = join_window_seq + 1,
					join_window_opened_at = $2, join_window_ends_at = $3, code_hmac = $4, code_enc = $5, link_enc = $6 WHERE id = $1::uuid`,
					sessionID, now, now.Add(JoinWindow), s.keys.codeHMAC(code), s.keys.seal(code), s.keys.seal(linkToken))
				return err
			})
			if isUniqueViolation(err) {
				continue
			}
			if err != nil {
				return err
			}
			break
		}
		_, err = tx.Exec(ctx, `INSERT INTO capability_tokens (token_hash, session_id, purpose, window_seq, via, created_at, expires_at)
			VALUES ($1, $2::uuid, 'join', (SELECT join_window_seq FROM share_sessions WHERE id = $2::uuid), 'link', $3, $4)`, linkHash, sessionID, now, now.Add(JoinWindow))
		if err == nil {
			s.logEvent(ctx, tx, sessionID, "CODE_RENEWED")
		}
		return err
	})
	if err != nil {
		return SessionView{}, err
	}
	s.emitSessionUpdated(ctx, sessionID)
	return s.View(ctx, c.DeviceID, sessionID)
}

// Close ends a session at the sender's request.
func (s *Service) Close(ctx context.Context, c Caller, sessionID string) error {
	if !ValidID(sessionID) {
		return ErrNotFound
	}
	var devices []string
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		r, err := requireSender(ctx, tx, sessionID, c.DeviceID)
		if err != nil {
			return err
		}
		if !r.live() {
			return nil // idempotent
		}
		ps, err := listParticipants(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		devices = liveDevices(ps)
		return s.end(ctx, tx, sessionID, StatusClosed, s.now())
	})
	if err != nil {
		return err
	}
	s.notifyDevices(devices, SessionEnded{Type: "SESSION_CLOSED", SessionID: sessionID})
	return nil
}

// end moves a session to a terminal status and schedules its purge.
func (s *Service) end(ctx context.Context, tx pgx.Tx, sessionID, status string, now time.Time) error {
	if _, err := tx.Exec(ctx, `UPDATE share_sessions SET status = $2, ended_at = $3, purge_after = $4,
		join_window_state = CASE WHEN join_window_state = 'OPEN' THEN 'ENDED_BY_SENDER' ELSE join_window_state END
		WHERE id = $1::uuid`, sessionID, status, now, now.Add(PurgeAfterEnd)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE capability_tokens SET revoked_at = $2 WHERE session_id = $1::uuid AND revoked_at IS NULL`, sessionID, now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE transfers SET status = 'CANCELLED', updated_at = $2 WHERE session_id = $1::uuid AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`, sessionID, now); err != nil {
		return err
	}
	s.logEvent(ctx, tx, sessionID, "SESSION_"+status)
	return nil
}
