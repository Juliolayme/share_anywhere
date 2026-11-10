package sharing

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// TickResult summarizes one maintenance pass (for logs and tests).
type TickResult struct {
	WindowsExpired, SessionsExpired, Purged int
}

// Tick expires join windows, ends idle and over-age sessions, purges old records, and announces protected
// mode turning off. It is safe to run concurrently with requests.
func (s *Service) Tick(ctx context.Context) (TickResult, error) {
	now := s.now()
	var res TickResult

	// 1. Join windows past their end.
	rows, err := s.cfg.Pool.Query(ctx, `UPDATE share_sessions SET join_window_state = 'EXPIRED'
		WHERE join_window_state = 'OPEN' AND join_window_ends_at <= $1 RETURNING id::text`, now)
	if err != nil {
		return res, err
	}
	expiredWindows, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return res, err
	}
	res.WindowsExpired = len(expiredWindows)
	for _, id := range expiredWindows {
		s.emitSessionUpdated(ctx, id)
	}

	// 2. Live sessions: refresh activity while any participant is connected; expire idle or over-age ones.
	rows, err = s.cfg.Pool.Query(ctx, `SELECT s.id::text, s.last_activity_at, s.expires_at, p.device_id::text
		FROM share_sessions s JOIN session_participants p ON p.session_id = s.id
		WHERE s.status IN ('WAITING','ACTIVE') AND (p.role = 'sender' OR p.status IN ('JOINED','REQUESTED'))`)
	if err != nil {
		return res, err
	}
	type live struct {
		lastActivity, expires time.Time
		devices               []string
	}
	sessions := map[string]*live{}
	for rows.Next() {
		var id, dev string
		var last, exp time.Time
		if err := rows.Scan(&id, &last, &exp, &dev); err != nil {
			rows.Close()
			return res, err
		}
		if sessions[id] == nil {
			sessions[id] = &live{lastActivity: last, expires: exp}
		}
		sessions[id].devices = append(sessions[id].devices, dev)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}
	for id, l := range sessions {
		connected := false
		if s.cfg.Notify != nil {
			for _, d := range l.devices {
				if s.cfg.Notify.Connected(d) {
					connected = true
					break
				}
			}
		}
		reason := ""
		switch {
		case !now.Before(l.expires):
			reason = "max_lifetime"
		case connected:
			if _, err := s.cfg.Pool.Exec(ctx, `UPDATE share_sessions SET last_activity_at = $2 WHERE id = $1::uuid`, id, now); err != nil {
				return res, err
			}
		case now.Sub(l.lastActivity) >= IdleTimeout:
			reason = "idle"
		}
		if reason == "" {
			continue
		}
		err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
			r, err := lockSession(ctx, tx, id)
			if err != nil || !r.live() {
				return err
			}
			return s.end(ctx, tx, id, StatusExpired, now)
		})
		if err != nil {
			return res, err
		}
		res.SessionsExpired++
		s.notifyDevices(l.devices, SessionEnded{Type: "SESSION_EXPIRED", SessionID: id, Reason: reason})
	}

	// 3. Purge ended sessions after 7 days (cascades to participants, files, tokens, transfers, events).
	tag, err := s.cfg.Pool.Exec(ctx, `DELETE FROM share_sessions WHERE purge_after IS NOT NULL AND purge_after <= $1`, now)
	if err != nil {
		return res, err
	}
	res.Purged = int(tag.RowsAffected())
	if _, err := s.cfg.Pool.Exec(ctx, `DELETE FROM capability_tokens WHERE purpose = 'join_ticket' AND expires_at <= $1`, now.Add(-time.Hour)); err != nil {
		return res, err
	}

	// 4. Prune expired lockouts; account protected-mode time; announce protected mode switching off.
	s.mu.Lock()
	for k, until := range s.lockout {
		if !now.Before(until) {
			delete(s.lockout, k)
		}
	}
	on, until := s.cfg.Protected.Active()
	if on && !s.lastTick.IsZero() && now.After(s.lastTick) {
		s.m.protectedSeconds.Add(int64(now.Sub(s.lastTick).Seconds()))
	}
	s.lastTick = now
	announce := s.protectedWasOn && !on
	s.protectedWasOn = on
	s.mu.Unlock()
	if announce && s.cfg.Notify != nil {
		s.cfg.Notify.Broadcast(ProtectedModeEvent{Type: "PROTECTED_MODE", Active: false, Until: until})
	}
	return res, nil
}

// SetProtected forces protected mode on or off (nil returns to automatic) and announces the state. Used only
// by the test-build admin hook.
func (s *Service) SetProtected(on *bool) (bool, time.Time) {
	s.cfg.Protected.Force(on)
	active, until := s.cfg.Protected.Active()
	s.mu.Lock()
	s.protectedWasOn = active
	s.mu.Unlock()
	if s.cfg.Notify != nil {
		s.cfg.Notify.Broadcast(ProtectedModeEvent{Type: "PROTECTED_MODE", Active: active, Until: until})
	}
	return active, until
}

// LockDeviceForTest locks a device out of code lookups (test-build admin hook only), so end-to-end specs can
// check the locked-out message without hundreds of failed lookups from the shared test address.
func (s *Service) LockDeviceForTest(deviceID string, d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lockout["dev:"+deviceID] = s.cfg.Clock.Now().Add(d)
}

// Run ticks every interval until ctx ends.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if res, err := s.Tick(ctx); err != nil {
				s.cfg.Log.Error("sharing maintenance failed", "error", err.Error())
			} else if res.SessionsExpired+res.Purged > 0 {
				s.cfg.Log.Info("sharing maintenance", "windows_expired", res.WindowsExpired, "sessions_expired", res.SessionsExpired, "purged", res.Purged)
			}
		}
	}
}

// ---- authorization for signaling and TURN ----

// SignalRoute authorizes a signaling message from a device in a session to a participant and returns the
// sender's participant ID and the target device. Only the sender and JOINED receivers of a live session may
// signal, and only along a sender–receiver pair (docs/API.md §4).
func (s *Service) SignalRoute(ctx context.Context, fromDevice, sessionID, toParticipant string) (fromParticipant, toDevice string, err error) {
	if !ValidID(sessionID) || !ValidID(toParticipant) {
		return "", "", ErrNotFound
	}
	r, err := scanSession(s.cfg.Pool.QueryRow(ctx, `SELECT `+sessionCols+` FROM share_sessions WHERE id = $1::uuid`, sessionID))
	if err != nil || !r.live() {
		return "", "", ErrNotFound
	}
	from, err := participantFor(ctx, s.cfg.Pool, sessionID, fromDevice)
	if err != nil || (from.Role == "receiver" && from.Status != PJoined) {
		return "", "", ErrNotFound
	}
	to, err := scanParticipant(s.cfg.Pool.QueryRow(ctx, `SELECT `+participantCols+` FROM session_participants WHERE id = $1::uuid AND session_id = $2::uuid`, toParticipant, sessionID))
	if err != nil || to.Role == from.Role || (to.Role == "receiver" && to.Status != PJoined) {
		return "", "", ErrNotFound
	}
	return from.ID, to.DeviceID, nil
}

// TurnParticipant authorizes a TURN credential request: the sender or a JOINED receiver of an ACTIVE session.
func (s *Service) TurnParticipant(ctx context.Context, deviceID, sessionID string) (string, error) {
	if !ValidID(sessionID) {
		return "", ErrNotFound
	}
	r, err := scanSession(s.cfg.Pool.QueryRow(ctx, `SELECT `+sessionCols+` FROM share_sessions WHERE id = $1::uuid`, sessionID))
	if err != nil {
		return "", ErrNotFound
	}
	p, err := participantFor(ctx, s.cfg.Pool, sessionID, deviceID)
	if err != nil || (p.Role == "receiver" && p.Status != PJoined) {
		return "", ErrNotFound
	}
	if r.Status != StatusActive {
		return "", errf(409, "session_not_active", "TURN credentials are available once a receiver has joined.")
	}
	return p.ID, nil
}
