package transfers

import (
	"sync"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// Session aggregate end to end through the services (docs/ARCHITECTURE.md §4.5). The rule itself is
// enumerated in sharing/aggregate_test.go; these tests check that every path that ends a transfer or a
// receiver applies it, under the session row lock, and announces it once.

func (n *notes) sessionStatuses(id string) (out []string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, e := range n.ev[id] {
		if v, ok := e.(sharing.SessionUpdated); ok {
			out = append(out, v.Status)
		}
	}
	return out
}

func count(xs []string, x string) (n int) {
	for _, v := range xs {
		if v == x {
			n++
		}
	}
	return n
}

func (e *env) status(sessionID string) string {
	e.t.Helper()
	var s string
	if err := e.pool.QueryRow(ctx, `SELECT status FROM share_sessions WHERE id = $1::uuid`, sessionID).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *env) transfers(rx sharing.Caller, sessionID string) List {
	e.t.Helper()
	l, err := e.svc.List(ctx, rx.DeviceID, sessionID)
	if err != nil {
		e.t.Fatal(err)
	}
	return l
}

// finish drives one transfer to COMPLETED (verified) or FAILED.
func (e *env) finish(rx sharing.Caller, tr Transfer, ok bool) {
	e.t.Helper()
	steps := []Report{{Status: Connecting}, {Status: Transferring, VerifiedBytes: tr.Size / 2}}
	if ok {
		steps = append(steps, Report{Status: Completed, VerifiedBytes: tr.Size})
	} else {
		steps = append(steps, Report{Status: Failed, VerifiedBytes: tr.Size / 2})
	}
	for _, r := range steps {
		if _, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, r); err != nil {
			e.t.Fatalf("%+v: %v", r, err)
		}
	}
}

func (e *env) stopAccepting(sender sharing.Caller, sessionID string) {
	e.t.Helper()
	no := false
	if _, err := e.share.Update(ctx, sender, sessionID, sharing.UpdateInput{AcceptingReceivers: &no}); err != nil {
		e.t.Fatal(err)
	}
}

func TestSessionCompletesWhenEveryTransferCompletes(t *testing.T) {
	e := newEnv(t, 1000)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	e.stopAccepting(sender, s.ID)
	l := e.transfers(rx, s.ID)

	e.finish(rx, byFile(l, 1000), true)
	if got := e.status(s.ID); got != sharing.StatusActive {
		t.Fatalf("one file left: %s", got)
	}
	e.finish(rx, byFile(l, 10), true)
	if got := e.status(s.ID); got != sharing.StatusCompleted {
		t.Fatalf("every file verified: %s", got)
	}
	for _, dev := range []string{sender.DeviceID, rx.DeviceID} {
		if st := e.note.sessionStatuses(dev); count(st, sharing.StatusCompleted) != 1 {
			t.Fatalf("SESSION_UPDATED COMPLETED once to each side, got %v", st)
		}
	}
	for _, dev := range []string{sender.DeviceID, rx.DeviceID} {
		v, err := e.share.View(ctx, dev, s.ID)
		if err != nil || v.Status != sharing.StatusCompleted {
			t.Fatalf("view: %s %v", v.Status, err)
		}
	}
	// The transfer records stay readable for the result screens; the session has ended (purge scheduled,
	// counted, no new activity, open-session slot freed).
	if got := e.transfers(rx, s.ID); len(got.Transfers) != 2 || got.Transfers[0].Status != Completed {
		t.Fatalf("transfers after completion: %+v", got)
	}
	var purge *time.Time
	_ = e.pool.QueryRow(ctx, `SELECT purge_after FROM share_sessions WHERE id = $1::uuid`, s.ID).Scan(&purge)
	if purge == nil || !purge.Equal(e.clk.Now().Add(sharing.PurgeAfterEnd)) {
		t.Fatalf("purge_after: %v", purge)
	}
	if _, err := e.svc.Report(ctx, rx.DeviceID, byFile(l, 10).ID, Report{Status: Completed, VerifiedBytes: 10}); err != nil {
		t.Fatalf("repeating the final report stays idempotent: %v", err)
	}
	if !contains(scrape(e.reg), "sa_sessions_completed_total 1") {
		t.Fatalf("metrics:\n%s", scrape(e.reg))
	}
	if _, err := e.share.Create(ctx, sender, sharing.CreateInput{Files: []sharing.FileInput{{Name: "a", Size: 1}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.share.Create(ctx, sender, sharing.CreateInput{Files: []sharing.FileInput{{Name: "b", Size: 1}}}); err != nil {
		t.Fatalf("a completed session no longer counts toward the open-session cap: %v", err)
	}
}

// While the join window is open another receiver may still arrive, so the session stays ACTIVE; the
// maintenance job settles it once the window expires.
func TestOpenWindowKeepsSessionActiveUntilItEnds(t *testing.T) {
	e := newEnv(t, 1000)
	sender, first, late := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	e.join(first, s.Code)
	for _, tr := range e.transfers(first, s.ID).Transfers {
		e.finish(first, tr, true)
	}
	if got := e.status(s.ID); got != sharing.StatusActive {
		t.Fatalf("window open: %s", got)
	}
	e.clk.Advance(5 * time.Minute)
	if res, err := e.share.Tick(ctx); err != nil || res.SessionsCompleted != 0 || e.status(s.ID) != sharing.StatusActive {
		t.Fatalf("tick while the window is open: %+v %v %s", res, err, e.status(s.ID))
	}
	e.join(late, s.Code) // the reason the session stayed open
	l := e.transfers(late, s.ID)
	e.finish(late, byFile(l, 1000), true)
	e.finish(late, byFile(l, 10), false)
	e.clk.Advance(5 * time.Minute)
	res, err := e.share.Tick(ctx)
	if err != nil || res.WindowsExpired != 1 || res.SessionsPartial != 1 || res.SessionsCompleted != 0 {
		t.Fatalf("tick after the window: %+v %v", res, err)
	}
	if got := e.status(s.ID); got != sharing.StatusPartiallyCompleted {
		t.Fatalf("one file failed for one receiver: %s", got)
	}
	if st := e.note.sessionStatuses(sender.DeviceID); count(st, sharing.StatusPartiallyCompleted) != 1 {
		t.Fatalf("sender updates: %v", st)
	}
	if res, _ := e.share.Tick(ctx); res.SessionsPartial != 0 {
		t.Fatalf("settled sessions are not revisited: %+v", res)
	}
	wantCode(t, mustJoin(e, e.device("Too late"), s.Code), "session_expired")
	if !contains(scrape(e.reg), "sa_sessions_partially_completed_total 1") {
		t.Fatalf("metrics:\n%s", scrape(e.reg))
	}
}

func mustJoin(e *env, c sharing.Caller, code string) error {
	p, err := e.share.ResolveCode(ctx, c, code)
	if err != nil {
		return err
	}
	_, err = e.share.Join(ctx, c, p.SessionID, p.JoinTicket)
	return err
}

// A transfer that ends without completing (failed by the receiver, cancelled by the sender) makes the result
// partial once everything else is done.
func TestPartialCompletionAcrossReceivers(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	e.join(a, s.Code)
	e.join(b, s.Code)
	e.stopAccepting(sender, s.ID)
	for _, tr := range e.transfers(a, s.ID).Transfers {
		e.finish(a, tr, true)
	}
	lb := e.transfers(b, s.ID)
	e.finish(b, byFile(lb, 10), true)
	if got := e.status(s.ID); got != sharing.StatusActive {
		t.Fatalf("b still has a file: %s", got)
	}
	if _, err := e.svc.Report(ctx, b.DeviceID, byFile(lb, 1000).ID, Report{Status: Connecting}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Action(ctx, sender.DeviceID, byFile(lb, 1000).ID, "cancel", ""); err != nil {
		t.Fatal(err)
	}
	if got := e.status(s.ID); got != sharing.StatusPartiallyCompleted {
		t.Fatalf("sender cancelled b's last file: %s", got)
	}
}

// Remove, Block and Leave settle the session in the same transaction that cancels the departing receiver's
// transfers. Removed and blocked receivers do not count; one that left early does.
func TestDepartingReceiversSettleTheSession(t *testing.T) {
	cases := []struct {
		name string
		act  func(e *env, sender, b sharing.Caller, participantID string) error
		want string
	}{
		{"remove", func(e *env, sender, _ sharing.Caller, pid string) error {
			_, err := e.share.Decide(ctx, sender, pid, "remove")
			return err
		}, sharing.StatusCompleted},
		{"block", func(e *env, sender, _ sharing.Caller, pid string) error {
			_, err := e.share.Decide(ctx, sender, pid, "block")
			return err
		}, sharing.StatusCompleted},
		{"leave", func(e *env, _, b sharing.Caller, pid string) error {
			_, err := e.share.Leave(ctx, b, pid)
			return err
		}, sharing.StatusPartiallyCompleted},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t, 1000)
			sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
			s := e.session(sender, false)
			e.join(a, s.Code)
			jb := e.join(b, s.Code)
			e.stopAccepting(sender, s.ID)
			for _, tr := range e.transfers(a, s.ID).Transfers {
				e.finish(a, tr, true)
			}
			if _, err := e.svc.Report(ctx, b.DeviceID, byFile(e.transfers(b, s.ID), 1000).ID, Report{Status: Connecting}); err != nil {
				t.Fatal(err)
			}
			if got := e.status(s.ID); got != sharing.StatusActive {
				t.Fatalf("b mid-transfer: %s", got)
			}
			if err := c.act(e, sender, b, jb.Participant.ID); err != nil {
				t.Fatal(err)
			}
			if got := e.status(s.ID); got != c.want {
				t.Fatalf("got %s, want %s", got, c.want)
			}
			if st := e.note.sessionStatuses(a.DeviceID); count(st, c.want) != 1 {
				t.Fatalf("remaining receiver updates: %v", st)
			}
		})
	}
}

// A receiver waiting for approval holds the session open; rejecting it lets the session complete.
func TestRequestedReceiverHoldsSessionOpen(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, true)
	ja := e.join(a, s.Code)
	if _, err := e.share.Decide(ctx, sender, ja.Participant.ID, "approve"); err != nil {
		t.Fatal(err)
	}
	jb := e.join(b, s.Code)
	if jb.Participant.Status != sharing.PRequested {
		t.Fatalf("b: %s", jb.Participant.Status)
	}
	e.stopAccepting(sender, s.ID)
	for _, tr := range e.transfers(a, s.ID).Transfers {
		e.finish(a, tr, true)
	}
	e.clk.Advance(time.Minute)
	if _, err := e.share.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if got := e.status(s.ID); got != sharing.StatusActive {
		t.Fatalf("pending request: %s", got)
	}
	if _, err := e.share.Decide(ctx, sender, jb.Participant.ID, "reject"); err != nil {
		t.Fatal(err)
	}
	if got := e.status(s.ID); got != sharing.StatusCompleted {
		t.Fatalf("after reject: %s", got)
	}
}

// A session that delivered nothing never ends by itself: the sender can create a new code or close it.
func TestNothingDeliveredStaysActive(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	ja := e.join(a, s.Code)
	e.stopAccepting(sender, s.ID)
	for _, tr := range e.transfers(a, s.ID).Transfers {
		e.finish(a, tr, false)
	}
	e.clk.Advance(time.Minute)
	if res, err := e.share.Tick(ctx); err != nil || res.SessionsCompleted+res.SessionsPartial != 0 {
		t.Fatalf("tick: %+v %v", res, err)
	}
	if got := e.status(s.ID); got != sharing.StatusActive {
		t.Fatalf("all failed: %s", got)
	}
	// Removing everyone leaves it ACTIVE as well; Create new code admits someone else, who completes.
	if _, err := e.share.Decide(ctx, sender, ja.Participant.ID, "remove"); err != nil {
		t.Fatal(err)
	}
	v, err := e.share.Renew(ctx, sender, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	e.join(b, v.Code)
	e.stopAccepting(sender, s.ID)
	for _, tr := range e.transfers(b, s.ID).Transfers {
		e.finish(b, tr, true)
	}
	if got := e.status(s.ID); got != sharing.StatusCompleted {
		t.Fatalf("after the new receiver: %s", got)
	}
}

// Close yields CLOSED whatever the transfers say, and the aggregate never reopens or changes an ended session.
func TestCloseYieldsClosed(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(a, s.Code)
	e.stopAccepting(sender, s.ID)
	e.finish(a, byFile(e.transfers(a, s.ID), 1000), true)
	if err := e.share.Close(ctx, sender, s.ID); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(time.Minute)
	if _, err := e.share.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if got := e.status(s.ID); got != sharing.StatusClosed {
		t.Fatalf("closed: %s", got)
	}
	if got := e.transfers(a, s.ID); byFile(got, 10).Status != Cancelled || byFile(got, 1000).Status != Completed {
		t.Fatalf("close cancels only unfinished transfers: %+v", got.Transfers)
	}
}

// Five receivers finishing their last file at the same moment: exactly one transaction settles the session
// and it is announced once (the session row is locked before the transfer row on every path).
func TestConcurrentFinalTransfersSettleOnce(t *testing.T) {
	e := newEnv(t, 1000)
	sender := e.device("Minh")
	s := e.session(sender, false)
	var rxs []sharing.Caller
	for i := 0; i < sharing.MaxReceivers; i++ {
		c := e.device("R")
		e.join(c, s.Code)
		rxs = append(rxs, c)
	}
	last := make([]Transfer, len(rxs))
	for i, c := range rxs {
		l := e.transfers(c, s.ID)
		e.finish(c, byFile(l, 10), true)
		tr := byFile(l, 1000)
		for _, r := range []Report{{Status: Connecting}, {Status: Transferring, VerifiedBytes: 999}} {
			if _, err := e.svc.Report(ctx, c.DeviceID, tr.ID, r); err != nil {
				t.Fatal(err)
			}
		}
		last[i] = tr
	}
	if got := e.status(s.ID); got != sharing.StatusActive {
		t.Fatalf("before: %s", got) // the fifth join ended the window (full), so only transfers hold it
	}
	var wg sync.WaitGroup
	errs := make([]error, len(rxs))
	for i, c := range rxs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = e.svc.Report(ctx, c.DeviceID, last[i].ID, Report{Status: Completed, VerifiedBytes: 1000})
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("receiver %d: %v", i, err)
		}
	}
	if got := e.status(s.ID); got != sharing.StatusCompleted {
		t.Fatalf("after: %s", got)
	}
	if st := e.note.sessionStatuses(sender.DeviceID); count(st, sharing.StatusCompleted) != 1 {
		t.Fatalf("announced %d times: %v", count(st, sharing.StatusCompleted), st)
	}
	if !contains(scrape(e.reg), "sa_sessions_completed_total 1") {
		t.Fatalf("metrics:\n%s", scrape(e.reg))
	}
}

// The maintenance job cancels transfers left unfinished by an ended session or a departed receiver (records
// an interrupted or older code path could leave), settles what that finishes, and purges ended sessions with
// their transfers 7 days after they end (docs/SECURITY_MODEL.md §6).
func TestTickCancelsOrphansAndPurges(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	e.join(a, s.Code)
	jb := e.join(b, s.Code)
	e.stopAccepting(sender, s.ID)
	for _, tr := range e.transfers(a, s.ID).Transfers {
		e.finish(a, tr, true)
	}
	// b "left" without its transfers being cancelled.
	if _, err := e.pool.Exec(ctx, `UPDATE session_participants SET status = 'LEFT' WHERE id = $1::uuid`, jb.Participant.ID); err != nil {
		t.Fatal(err)
	}
	// A closed session whose transfers were left running.
	s2 := e.session(e.device("Other sender"), false)
	c := e.device("Mai")
	e.join(c, s2.Code)
	if _, err := e.pool.Exec(ctx, `UPDATE share_sessions SET status = 'CLOSED', ended_at = $2, purge_after = $3 WHERE id = $1::uuid`,
		s2.ID, e.clk.Now(), e.clk.Now().Add(sharing.PurgeAfterEnd)); err != nil {
		t.Fatal(err)
	}
	res, err := e.share.Tick(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.OrphansCancelled != 4 || res.SessionsPartial != 1 {
		t.Fatalf("tick: %+v", res)
	}
	var open int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM transfers WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED')`).Scan(&open)
	if open != 0 {
		t.Fatalf("%d unfinished transfers remain", open)
	}
	if got := e.status(s.ID); got != sharing.StatusPartiallyCompleted {
		t.Fatalf("b left early: %s", got)
	}
	if !contains(scrape(e.reg), "sa_orphan_transfers_cancelled_total 4") {
		t.Fatalf("metrics:\n%s", scrape(e.reg))
	}
	if res, _ := e.share.Tick(ctx); res.OrphansCancelled != 0 {
		t.Fatalf("second tick: %+v", res)
	}
	e.clk.Advance(sharing.PurgeAfterEnd + time.Minute)
	res, err = e.share.Tick(ctx)
	if err != nil || res.Purged != 2 {
		t.Fatalf("purge: %+v %v", res, err)
	}
	var n int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM transfers`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d transfers outlived their sessions", n)
	}
}
