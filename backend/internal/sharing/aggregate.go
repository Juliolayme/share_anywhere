package sharing

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Session statuses derived from transfers (docs/ARCHITECTURE.md §4.5).
const (
	StatusCompleted          = "COMPLETED"
	StatusPartiallyCompleted = "PARTIALLY_COMPLETED"
)

// ReceiverState is one receiver as the aggregate rule sees it: its participant status and the status of each
// of its transfers (one per file; empty for a receiver that never reached JOINED).
type ReceiverState struct {
	Status    string
	Transfers []string
}

func transferTerminal(s string) bool { return s == "COMPLETED" || s == "FAILED" || s == "CANCELLED" }

// countsTowardResult reports whether a receiver's transfers decide the session result. JOINED receivers and
// receivers that LEFT on their own count (a receiver that left early did not get the files: partial). REMOVED
// and BLOCKED receivers were excluded by the sender, so their cancelled transfers are not a delivery shortfall;
// REJECTED receivers never had live transfers. REQUESTED receivers hold the session open (see Derive).
func countsTowardResult(participantStatus string) bool {
	return participantStatus == PJoined || participantStatus == PLeft
}

// Derive is the session aggregate rule (docs/ARCHITECTURE.md §4.5). It returns the status the session should
// have given its current status, whether its join window is effectively open, and its receivers:
//
//   - Only an ACTIVE session changes. WAITING (nobody ever joined) and every ended status (CLOSED, EXPIRED,
//     CANCELLED, COMPLETED, PARTIALLY_COMPLETED) are returned unchanged, so Close always yields CLOSED.
//   - The session stays ACTIVE while the join window is open (someone may still join), while any receiver is
//     REQUESTED (the sender may still approve), and while any counted transfer is not terminal.
//   - Counted transfers are those of JOINED and LEFT receivers (countsTowardResult). With none, it stays ACTIVE
//     (every receiver was removed or blocked: the sender may create a new code).
//   - All counted transfers terminal: COMPLETED when all of them are COMPLETED, PARTIALLY_COMPLETED when some
//     are; when none completed (all FAILED or CANCELLED) the session stays ACTIVE, so the sender can create a new
//     code or close it, and the idle and maximum lifetimes still end it. A session never ends automatically
//     without having delivered something.
func Derive(current string, windowOpen bool, receivers []ReceiverState) string {
	if current != StatusActive || windowOpen {
		return current
	}
	total, completed := 0, 0
	for _, r := range receivers {
		if r.Status == PRequested {
			return current
		}
		if !countsTowardResult(r.Status) {
			continue
		}
		for _, t := range r.Transfers {
			if !transferTerminal(t) {
				return current
			}
			total++
			if t == "COMPLETED" {
				completed++
			}
		}
	}
	switch {
	case total == 0 || completed == 0:
		return current
	case completed == total:
		return StatusCompleted
	default:
		return StatusPartiallyCompleted
	}
}

// receiverStates loads every receiver of a session with its transfer statuses.
func receiverStates(ctx context.Context, q querier, sessionID string) ([]ReceiverState, error) {
	rows, err := q.Query(ctx, `SELECT p.id::text, p.status, t.status FROM session_participants p
		LEFT JOIN transfers t ON t.participant_id = p.id
		WHERE p.session_id = $1::uuid AND p.role = 'receiver' ORDER BY p.id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReceiverState
	last := ""
	for rows.Next() {
		var id, status string
		var t *string
		if err := rows.Scan(&id, &status, &t); err != nil {
			return nil, err
		}
		if id != last {
			out = append(out, ReceiverState{Status: status})
			last = id
		}
		if t != nil {
			out[len(out)-1].Transfers = append(out[len(out)-1].Transfers, *t)
		}
	}
	return out, rows.Err()
}

// settle re-derives the session status inside tx and, when the rule says so, ends the session as COMPLETED
// or PARTIALLY_COMPLETED. It locks the session row; callers that also change transfers must lock the session
// row before any transfer row (every path in this package and in transfers does) so the lock order is the same
// everywhere. With the row locked, the transfer statuses read here include every committed change, so two
// receivers finishing at the same moment cannot both miss the final state.
func (s *Service) settle(ctx context.Context, tx pgx.Tx, sessionID string, now time.Time) (string, bool, error) {
	r, err := lockSession(ctx, tx, sessionID)
	if err != nil {
		return "", false, err
	}
	if r.Status != StatusActive {
		return r.Status, false, nil
	}
	rs, err := receiverStates(ctx, tx, sessionID)
	if err != nil {
		return "", false, err
	}
	next := Derive(r.Status, r.effectiveWindow(now) == WindowOpen, rs)
	if next == r.Status {
		return r.Status, false, nil
	}
	if err := s.end(ctx, tx, sessionID, next, now); err != nil {
		return "", false, err
	}
	return next, true, nil
}

// Settle applies the aggregate rule after a transfer change recorded in tx (used by the transfers package
// before it commits). It returns the session status and whether it changed; when it did, the caller calls
// Settled after committing.
func (s *Service) Settle(ctx context.Context, tx pgx.Tx, sessionID string) (string, bool, error) {
	return s.settle(ctx, tx, sessionID, s.now())
}

// Settled counts a session the aggregate rule ended and sends SESSION_UPDATED (with the new status) to its
// sender and its JOINED receivers. Call it only after the transaction that settled the session committed.
func (s *Service) Settled(ctx context.Context, sessionID, status string) {
	switch status {
	case StatusCompleted:
		s.m.sessionsCompleted.Inc()
	case StatusPartiallyCompleted:
		s.m.sessionsPartial.Inc()
	}
	s.emitSessionUpdated(ctx, sessionID)
}

// settleDue finalizes ACTIVE sessions the aggregate rule says are finished but that no request settled, such
// as a session whose last transfer ended while its join window was still open (the window then expired in
// step 1 of Tick) or one missed because the process stopped between commits. The query mirrors Derive's
// necessary conditions so that sessions that stay ACTIVE are not revisited every tick; settle decides.
func (s *Service) settleDue(ctx context.Context, now time.Time, res *TickResult) error {
	rows, err := s.cfg.Pool.Query(ctx, `SELECT s.id::text FROM share_sessions s
		WHERE s.status = 'ACTIVE' AND NOT (s.join_window_state = 'OPEN' AND s.join_window_ends_at > $1)
		AND NOT EXISTS (SELECT 1 FROM session_participants p WHERE p.session_id = s.id AND p.role = 'receiver' AND p.status = 'REQUESTED')
		AND NOT EXISTS (SELECT 1 FROM transfers t JOIN session_participants p ON p.id = t.participant_id
			WHERE t.session_id = s.id AND p.status IN ('JOINED','LEFT') AND t.status NOT IN ('COMPLETED','FAILED','CANCELLED'))
		AND EXISTS (SELECT 1 FROM transfers t JOIN session_participants p ON p.id = t.participant_id
			WHERE t.session_id = s.id AND p.status IN ('JOINED','LEFT') AND t.status = 'COMPLETED')`, now)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, id := range ids {
		var status string
		var changed bool
		err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
			var err error
			status, changed, err = s.settle(ctx, tx, id, now)
			return err
		})
		if err != nil {
			return err
		}
		if changed {
			res.countSettled(status)
			s.Settled(ctx, id, status)
		}
	}
	return nil
}
