package sharing

import (
	"context"
)

// Session end statuses that record the delivery result (docs/ARCHITECTURE.md §4.5).
const (
	StatusCompleted          = "COMPLETED"
	StatusPartiallyCompleted = "PARTIALLY_COMPLETED"
)

// ReceiverState is one receiver as the end-status rule sees it: its participant status and the status of each
// of its transfers (one per file; empty for a receiver that never reached JOINED).
type ReceiverState struct {
	Status    string
	Transfers []string
}

// countsTowardResult reports whether a receiver's transfers decide the session result. JOINED receivers and
// receivers that LEFT on their own count (a receiver that left early did not get every file: partial). REMOVED
// and BLOCKED receivers were excluded by the sender, so their cancelled transfers are not a delivery shortfall,
// but one that had already received every file before it was excluded still counts as a delivery. REJECTED and
// REQUESTED receivers never had live transfers.
func countsTowardResult(r ReceiverState) bool {
	switch r.Status {
	case PJoined, PLeft:
		return true
	case PRemoved, PBlocked:
		return allCompleted(r.Transfers)
	}
	return false
}

func allCompleted(ts []string) bool {
	for _, t := range ts {
		if t != "COMPLETED" {
			return false
		}
	}
	return len(ts) > 0
}

// EndStatus is the status a live session records when its idle or maximum lifetime ends it
// (docs/ARCHITECTURE.md §4.5). Nothing else ends a live session automatically: window expiry, Stop accepting,
// Remove, Block, Reject, Leave and final transfer reports leave it live so the sender can Create new code, and
// the sender's Close always records CLOSED.
//
//   - Counted transfers are those of JOINED and LEFT receivers, and of REMOVED or BLOCKED receivers that had
//     received every file (countsTowardResult).
//   - COMPLETED when there is at least one counted transfer and every one is COMPLETED.
//   - PARTIALLY_COMPLETED when at least one is COMPLETED; transfers still running when the lifetime cut them off
//     count as not completed.
//   - EXPIRED otherwise: nothing was delivered (including a session nobody joined).
func EndStatus(receivers []ReceiverState) string {
	total, completed := 0, 0
	for _, r := range receivers {
		if !countsTowardResult(r) {
			continue
		}
		for _, t := range r.Transfers {
			total++
			if t == "COMPLETED" {
				completed++
			}
		}
	}
	switch completed {
	case 0:
		return StatusExpired
	case total:
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
