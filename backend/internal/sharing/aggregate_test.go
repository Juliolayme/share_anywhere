package sharing

import (
	"slices"
	"testing"
)

var (
	allTransferStates = []string{"PENDING", "CONNECTING", "TRANSFERRING", "PAUSED", "DISCONNECTED", "RECONNECTING", "RESUMING", "COMPLETED", "FAILED", "CANCELLED"}
	allReceiverStates = []string{PRequested, PJoined, PLeft, PRemoved, PBlocked, PRejected}
)

func rx(status string, transfers ...string) ReceiverState {
	return ReceiverState{Status: status, Transfers: transfers}
}

// TestEndStatusTable names the cases the rule exists for (docs/ARCHITECTURE.md §4.5).
func TestEndStatusTable(t *testing.T) {
	const (
		C  = StatusCompleted
		PC = StatusPartiallyCompleted
		E  = StatusExpired
	)
	cases := []struct {
		name      string
		receivers []ReceiverState
		want      string
	}{
		{"no receivers (WAITING)", nil, E},
		{"all completed", []ReceiverState{rx(PJoined, "COMPLETED", "COMPLETED")}, C},
		{"two receivers, all completed", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED")}, C},
		{"one failed", []ReceiverState{rx(PJoined, "COMPLETED", "FAILED")}, PC},
		{"one cancelled", []ReceiverState{rx(PJoined, "CANCELLED", "COMPLETED")}, PC},
		{"second receiver failed", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "FAILED")}, PC},
		{"LEFT early with nothing", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PLeft, "CANCELLED")}, PC},
		{"only receiver LEFT early with nothing", []ReceiverState{rx(PLeft, "CANCELLED", "CANCELLED")}, E},
		{"LEFT after completing", []ReceiverState{rx(PLeft, "COMPLETED", "COMPLETED")}, C},
		{"LEFT after completing, other completed", []ReceiverState{rx(PLeft, "COMPLETED"), rx(PJoined, "COMPLETED")}, C},
		{"removed excluded", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PRemoved, "CANCELLED")}, C},
		{"blocked excluded", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PBlocked, "CANCELLED")}, C},
		{"removed receiver had completed", []ReceiverState{rx(PRemoved, "COMPLETED")}, C},
		{"blocked after receiving every file", []ReceiverState{rx(PBlocked, "COMPLETED", "COMPLETED"), rx(PJoined, "FAILED")}, PC},
		{"removed after receiving some files", []ReceiverState{rx(PRemoved, "COMPLETED", "CANCELLED")}, E},
		{"only removed and blocked", []ReceiverState{rx(PRemoved, "CANCELLED"), rx(PBlocked, "CANCELLED")}, E},
		{"rejected ignored", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PRejected)}, C},
		{"requested ignored", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PRequested)}, C},
		{"rejoined and requested again ignored", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PRequested, "CANCELLED")}, C},
		{"only a request", []ReceiverState{rx(PRequested)}, E},
		{"non-terminal cut off", []ReceiverState{rx(PJoined, "COMPLETED", "TRANSFERRING")}, PC},
		{"receiver mid-transfer cut off", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "PAUSED")}, PC},
		{"nothing delivered, all failed", []ReceiverState{rx(PJoined, "FAILED", "CANCELLED")}, E},
		{"nothing delivered, still pending", []ReceiverState{rx(PJoined, "PENDING")}, E},
		{"joined, no transfers recorded", []ReceiverState{rx(PJoined)}, E},
		{"five receivers, all done", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED")}, C},
		{"five receivers, one failed", []ReceiverState{rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED"), rx(PJoined, "FAILED"), rx(PJoined, "COMPLETED"), rx(PJoined, "COMPLETED")}, PC},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := EndStatus(c.receivers); got != c.want {
				t.Fatalf("got %s, want %s", got, c.want)
			}
		})
	}
}

// checkEndStatus asserts the properties that together define EndStatus, for one input.
func checkEndStatus(t *testing.T, rs []ReceiverState) {
	t.Helper()
	got := EndStatus(rs)
	counted, completed := 0, 0
	for _, r := range rs {
		delivered := len(r.Transfers) > 0 && !slices.ContainsFunc(r.Transfers, func(s string) bool { return s != "COMPLETED" })
		counts := r.Status == PJoined || r.Status == PLeft || ((r.Status == PRemoved || r.Status == PBlocked) && delivered)
		if !counts {
			continue
		}
		for _, s := range r.Transfers {
			counted++
			if s == "COMPLETED" {
				completed++
			}
		}
	}
	var want string
	switch completed {
	case 0:
		want = StatusExpired
	case counted:
		want = StatusCompleted
	default:
		want = StatusPartiallyCompleted
	}
	if got != want {
		t.Fatalf("%v: got %s, want %s (counted=%d completed=%d)", rs, got, want, counted, completed)
	}
	// Only the three end statuses are ever produced, and the order of receivers never matters.
	if !slices.Contains([]string{StatusCompleted, StatusPartiallyCompleted, StatusExpired}, got) {
		t.Fatalf("%v: unexpected status %s", rs, got)
	}
	rev := slices.Clone(rs)
	slices.Reverse(rev)
	if r := EndStatus(rev); r != got {
		t.Fatalf("%v: order changed the result: %s vs %s", rs, r, got)
	}
}

// TestEndStatusEveryCombination enumerates every receiver status × transfer state for zero, one and two
// receivers with two files each, and three receivers with one file each.
func TestEndStatusEveryCombination(t *testing.T) {
	type two struct{ a, b string }
	var pairs []two
	for _, a := range allTransferStates {
		for _, b := range allTransferStates {
			pairs = append(pairs, two{a, b})
		}
	}
	checkEndStatus(t, nil)
	n := 1
	for _, s1 := range allReceiverStates {
		for _, p1 := range pairs {
			r1 := rx(s1, p1.a, p1.b)
			checkEndStatus(t, []ReceiverState{r1})
			n++
			for _, s2 := range allReceiverStates {
				for _, p2 := range pairs {
					checkEndStatus(t, []ReceiverState{r1, rx(s2, p2.a, p2.b)})
					n++
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
							checkEndStatus(t, []ReceiverState{rx(s1, t1), rx(s2, t2), rx(s3, t3)})
							n++
						}
					}
				}
			}
		}
	}
	// Rejected and requested receivers never change the result; removed and blocked ones only as a delivery
	// (every file received before the sender excluded them), exactly like a joined receiver that completed.
	for _, out := range []string{PRemoved, PBlocked, PRejected, PRequested} {
		for _, base := range [][]ReceiverState{nil, {rx(PJoined, "COMPLETED")}, {rx(PJoined, "COMPLETED"), rx(PJoined, "FAILED")}, {rx(PJoined, "PAUSED")}} {
			for _, p := range pairs {
				want := EndStatus(base)
				if (out == PRemoved || out == PBlocked) && p.a == "COMPLETED" && p.b == "COMPLETED" {
					want = EndStatus(append(slices.Clone(base), rx(PJoined, "COMPLETED", "COMPLETED")))
				}
				if got := EndStatus(append(slices.Clone(base), rx(out, p.a, p.b))); got != want {
					t.Fatalf("%s receiver with %v changed %v from %s to %s", out, p, base, want, got)
				}
			}
		}
	}
	// A completed transfer never makes the result worse; a not-completed one never makes it better.
	rank := map[string]int{StatusExpired: 0, StatusPartiallyCompleted: 1, StatusCompleted: 2}
	for _, s1 := range []string{PJoined, PLeft} {
		for _, p := range pairs {
			base := []ReceiverState{rx(s1, p.a, p.b)}
			before := EndStatus(base)
			if rank[EndStatus(append(slices.Clone(base), rx(PJoined, "COMPLETED")))] < rank[before] {
				t.Fatalf("%v: adding a completed receiver lowered %s", base, before)
			}
			if after := EndStatus(append(slices.Clone(base), rx(PJoined, "FAILED"))); after == StatusCompleted {
				t.Fatalf("%v: adding a failed receiver still COMPLETED", base)
			}
		}
	}
	t.Logf("checked %d combinations", n)
}
