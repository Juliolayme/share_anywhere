package sharing

import (
	"context"
	"errors"

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
