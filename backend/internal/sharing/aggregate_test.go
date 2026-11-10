package sharing

import (
	"slices"
	"testing"
)

var (
	allTransferStates = []string{"PENDING", "CONNECTING", "TRANSFERRING", "PAUSED", "DISCONNECTED", "RECONNECTING", "RESUMING", "COMPLETED", "FAILED", "CANCELLED"}
	allReceiverStates = []string{PRequested, PJoined, PLeft, PRemoved, PBlocked, PRejected}
	allSessionStates  = []string{StatusWaiting, StatusActive, StatusCompleted, StatusPartiallyCompleted, StatusClosed, StatusExpired, "CANCELLED"}
)

func rx(status string, transfers ...string) ReceiverState {
	return ReceiverState{Status: status, Transfers: transfers}
}

// TestDeriveTable names the cases the rule exists for (docs/ARCHITECTURE.md §4.5).
func TestDeriveTable(t *testing.T) {
	const (
		A  = StatusActive
		C  = StatusCompleted
		PC = StatusPartiallyCompleted
	)
	cases := []struct {
		name      string
		current   string
		window    bool
		receivers []ReceiverState
		want      string
	}{
		{"zero receivers, window ended", A, false, nil, A},
		{"zero receivers, waiting", StatusWaiting, false, nil, StatusWaiting},
		{"one receiver, all completed", A, false, []ReceiverState{rx(PJoined, "COMPLETED", "COMPLETED")}, C},
		{"one receiver, all completed, window open", A, true, []ReceiverState{rx(PJoined, "COMPLETED", "COMPLETED")}, A},
		{"one receiver, one file still transferring", A, false, []ReceiverState{rx(PJoined, "COMPLETED", "TRANSFERRING")}, A},
		{"one receiver, one file paused", A, false, []ReceiverState{rx(PJoined, "COMPLETED", "PAUSED")}, A},
		{"one receiver, one file pending", A, false, []ReceiverState{rx(PJoined, "COMPLETED", "PENDING")}, A},
		{"one receiver, one file reconnecting", A, false, []ReceiverState{rx(PJoined, "COMPLETED", "RECONNECTING")}, A},
		{"one receiver, completed and failed", A, false, []ReceiverState{rx(PJoined, "COMPLETED", "FAILED")}, PC},
		{"one receiver, completed and cancelled", A, false, []ReceiverState{rx(PJoined, "CANCELLED", "COMPLETED")}, PC},
		{"one receiver, all failed", A, false, []ReceiverState{rx(PJoined, "FAILED", "FAILED")}, A},
		{"one receiver, all cancelled", A, false, []ReceiverState{rx(PJoined, "CANCELLED", "CANCELLED")}, A},
		{"one receiver, failed and cancelled", A, false, []ReceiverState{rx(PJoined, "FAILED", "CANCELLED")}, A},
		{"two receivers, both done", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED")}, C},
		{"two receivers, one still going", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "RESUMING")}, A},
		{"two receivers, one failed", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "FAILED")}, PC},
		{"two receivers, one cancelled", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "CANCELLED")}, PC},
		{"completed receiver and a removed one", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PRemoved, "CANCELLED")}, C},
		{"completed receiver and a blocked one", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PBlocked, "CANCELLED")}, C},
		{"completed receiver and one that left early", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PLeft, "CANCELLED")}, PC},
		{"receiver left after finishing", A, false, []ReceiverState{rx(PLeft, "COMPLETED", "COMPLETED")}, C},
		{"only removed receivers", A, false, []ReceiverState{rx(PRemoved, "CANCELLED"), rx(PBlocked, "CANCELLED")}, A},
		{"removed receiver had completed", A, false, []ReceiverState{rx(PRemoved, "COMPLETED")}, A},
		{"rejected receiver, never joined", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PRejected)}, C},
		{"request waiting for approval", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PRequested)}, A},
		{"rejoined receiver waiting for approval", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PRequested, "CANCELLED")}, A},
		{"closed stays closed", StatusClosed, false, []ReceiverState{rx(PJoined, "COMPLETED")}, StatusClosed},
		{"expired stays expired", StatusExpired, false, []ReceiverState{rx(PJoined, "COMPLETED")}, StatusExpired},
		{"completed stays completed", C, true, []ReceiverState{rx(PJoined, "PENDING")}, C},
		{"partial stays partial", PC, false, []ReceiverState{rx(PJoined, "COMPLETED")}, PC},
		{"five receivers, all done", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED")}, C},
		{"five receivers, one failed", A, false, []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED"), rx(PJoined, "FAILED"), rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED")}, PC},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Derive(c.current, c.window, c.receivers); got != c.want {
				t.Fatalf("got %s, want %s", got, c.want)
			}
		})
	}
}

// checkDerive asserts the properties that together define Derive, for one input.
func checkDerive(t *testing.T, current string, window bool, rs []ReceiverState) {
	t.Helper()
	got := Derive(current, window, rs)
	if current != StatusActive || window {
		if got != current {
			t.Fatalf("%s window=%v %v: got %s, only an ACTIVE session with an ended window changes", current, window, rs, got)
		}
		return
	}
	requested, counted, completed, unfinished := false, 0, 0, 0
	for _, r := range rs {
		requested = requested || r.Status == PRequested
		if r.Status != PJoined && r.Status != PLeft {
			continue
		}
		for _, s := range r.Transfers {
			counted++
			switch s {
			case "COMPLETED":
				completed++
			case "FAILED", "CANCELLED":
			default:
				unfinished++
			}
		}
	}
	var want string
	switch {
	case requested || unfinished > 0 || completed == 0:
		want = StatusActive
	case completed == counted:
		want = StatusCompleted
	default:
		want = StatusPartiallyCompleted
	}
	if got != want {
		t.Fatalf("%v: got %s, want %s (requested=%v counted=%d completed=%d unfinished=%d)", rs, got, want, requested, counted, completed, unfinished)
	}
	// Order of receivers never matters.
	rev := slices.Clone(rs)
	slices.Reverse(rev)
	if r := Derive(current, window, rev); r != got {
		t.Fatalf("%v: order changed the result: %s vs %s", rs, r, got)
	}
}

// TestDeriveEveryCombination enumerates every session status × window state × receiver status × transfer state
// for zero, one and two receivers with two files each, and three receivers with one file each.
func TestDeriveEveryCombination(t *testing.T) {
	type two struct{ a, b string }
	var pairs []two
	for _, a := range allTransferStates {
		for _, b := range allTransferStates {
			pairs = append(pairs, two{a, b})
		}
	}
	n := 0
	for _, cur := range allSessionStates {
		for _, window := range []bool{false, true} {
			checkDerive(t, cur, window, nil)
			n++
			for _, s1 := range allReceiverStates {
				for _, p1 := range pairs {
					r1 := rx(s1, p1.a, p1.b)
					checkDerive(t, cur, window, []ReceiverState{r1})
					n++
					if cur != StatusActive || window {
						continue // unchanged regardless of receivers; one receiver already shows it
					}
					for _, s2 := range allReceiverStates {
						for _, p2 := range pairs {
							checkDerive(t, cur, window, []ReceiverState{r1, rx(s2, p2.a, p2.b)})
							n++
						}
					}
				}
			}
		}
	}
	for _, s1 := range allReceiverStates {
		for _, t1 := range allTransferStates {
			for _, s2 := range allReceiverStates {
				for _, t2 := range allTransferStates {
					for _, s3 := range allReceiverStates {
						for _, t3 := range allTransferStates {
							checkDerive(t, StatusActive, false, []ReceiverState{rx(s1, t1), rx(s2, t2), rx(s3, t3)})
							n++
						}
					}
				}
			}
		}
	}
	// Removed, blocked and rejected receivers never change the result, whatever their transfers say.
	for _, out := range []string{PRemoved, PBlocked, PRejected} {
		for _, base := range [][]ReceiverState{nil, {rx(PJoined, "COMPLETED")}, {rx(PJoined, "COMPLETED"), rx(PJoined, "FAILED")}, {rx(PJoined, "PAUSED")}} {
			want := Derive(StatusActive, false, base)
			for _, p := range pairs {
				if got := Derive(StatusActive, false, append(slices.Clone(base), rx(out, p.a, p.b))); got != want {
					t.Fatalf("%s receiver with %v changed %v from %s to %s", out, p, base, want, got)
				}
			}
		}
	}
	t.Logf("checked %d combinations", n)
}
