package transfers

import (
	"sync"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// Session end and result end to end through the services (docs/ARCHITECTURE.md §4.5). Nothing ends a live
// session automatically except its idle or maximum lifetime, and the end status then records the delivery
// result. The rule itself is enumerated in sharing/aggregate_test.go; these tests check that window expiry,
// Stop accepting, departures and final reports leave the session live, and that a lifetime end records the
// result under the session row lock.

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

func (n *notes) ended(id string) (out []sharing.SessionEnded) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, e := range n.ev[id] {
		if v, ok := e.(sharing.SessionEnded); ok {
			out = append(out, v)
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

// start moves a transfer to TRANSFERRING without finishing it.
func (e *env) start(rx sharing.Caller, tr Transfer) {
	e.t.Helper()
	for _, r := range []Report{{Status: Connecting}, {Status: Transferring, VerifiedBytes: tr.Size / 2}} {
		if _, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, r); err != nil {
			e.t.Fatalf("%+v: %v", r, err)
		}
	}
}

func (e *env) finishAll(rx sharing.Caller, sessionID string) {
	e.t.Helper()
	for _, tr := range e.transfers(rx, sessionID).Transfers {
		e.finish(rx, tr, true)
	}
}

func (e *env) stopAccepting(sender sharing.Caller, sessionID string) {
	e.t.Helper()
	no := false
	if _, err := e.share.Update(ctx, sender, sessionID, sharing.UpdateInput{AcceptingReceivers: &no}); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) tick() sharing.TickResult {
	e.t.Helper()
	res, err := e.share.Tick(ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	return res
}

// idleEnd disconnects everyone and runs the maintenance job past the idle lifetime.
func (e *env) idleEnd() sharing.TickResult {
	e.t.Helper()
	e.note.mu.Lock()
	e.note.offline = true
	e.note.mu.Unlock()
	e.clk.Advance(sharing.IdleTimeout + time.Minute)
	return e.tick()
}

// wantLive asserts the session is still ACTIVE and no SESSION_UPDATED announced an end status.
func (e *env) wantLive(sessionID string, devices ...string) {
	e.t.Helper()
	if got := e.status(sessionID); got != sharing.StatusActive {
		e.t.Fatalf("session ended by itself: %s", got)
	}
	for _, dev := range devices {
		st := e.note.sessionStatuses(dev)
		if count(st, sharing.StatusCompleted)+count(st, sharing.StatusPartiallyCompleted) != 0 {
			e.t.Fatalf("SESSION_UPDATED announced an end status: %v", st)
		}
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

// Regression for the Phase 4 QA P0: a receiver gets every file, the 10-minute window expires, and the session
// must stay live so the sender can Create new code and admit a late receiver (PRD §3, SECURITY_MODEL §3).
func TestWindowExpiryAfterDeliveryKeepsSessionLive(t *testing.T) {
	e := newEnv(t, 1000)
	sender, first, late := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	e.join(first, s.Code)
	e.finishAll(first, s.ID)
	e.wantLive(s.ID, sender.DeviceID, first.DeviceID)

	e.clk.Advance(sharing.JoinWindow + time.Minute)
	res := e.tick()
	if res.WindowsExpired != 1 || res.SessionsExpired+res.SessionsCompleted+res.SessionsPartial != 0 {
		t.Fatalf("tick after the window: %+v", res)
	}
	e.wantLive(s.ID, sender.DeviceID, first.DeviceID)
	wantCode(t, mustJoin(e, late, s.Code), "join_window_expired")

	v, err := e.share.Renew(ctx, sender, s.ID)
	if err != nil {
		t.Fatalf("Create new code after the window ended: %v", err)
	}
	if v.Status != sharing.StatusActive || v.JoinWindow.State != sharing.WindowOpen || v.Code == s.Code {
		t.Fatalf("renewed view: %s %s", v.Status, v.JoinWindow.State)
	}
	e.join(late, v.Code)
	e.finishAll(late, s.ID)
	if got := e.transfers(late, s.ID); byFile(got, 1000).Status != Completed || byFile(got, 10).Status != Completed {
		t.Fatalf("late receiver: %+v", got.Transfers)
	}
	e.clk.Advance(sharing.JoinWindow + time.Minute)
	e.tick()
	e.wantLive(s.ID, sender.DeviceID, first.DeviceID, late.DeviceID)
}

// Stop accepting after every transfer completed ends the window, never the session.
func TestStopAcceptingAfterDeliveryKeepsSessionLive(t *testing.T) {
	e := newEnv(t, 1000)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	e.finishAll(rx, s.ID)
	e.stopAccepting(sender, s.ID)
	e.clk.Advance(time.Minute)
	e.tick()
	e.wantLive(s.ID, sender.DeviceID, rx.DeviceID)
	if v, err := e.share.View(ctx, sender.DeviceID, s.ID); err != nil || v.JoinWindow.State != sharing.WindowEndedBySender {
		t.Fatalf("view: %+v %v", v.JoinWindow, err)
	}
	if _, err := e.share.Renew(ctx, sender, s.ID); err != nil {
		t.Fatalf("Create new code after Stop accepting: %v", err)
	}
}

// The idle lifetime ends a fully delivered session as COMPLETED.
func TestIdleEndRecordsCompleted(t *testing.T) {
	e := newEnv(t, 1000)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	e.finishAll(rx, s.ID)
	e.wantLive(s.ID, sender.DeviceID, rx.DeviceID)

	res := e.idleEnd()
	if res.SessionsExpired != 1 || res.SessionsCompleted != 1 || res.SessionsPartial != 0 {
		t.Fatalf("idle tick: %+v", res)
	}
	if got := e.status(s.ID); got != sharing.StatusCompleted {
		t.Fatalf("status: %s", got)
	}
	for _, dev := range []string{sender.DeviceID, rx.DeviceID} {
		v, err := e.share.View(ctx, dev, s.ID)
		if err != nil || v.Status != sharing.StatusCompleted {
			t.Fatalf("view: %s %v", v.Status, err)
		}
		if ev := e.note.ended(dev); len(ev) != 1 || ev[0].Type != "SESSION_EXPIRED" || ev[0].Reason != "idle" {
			t.Fatalf("lifetime end notice: %+v", ev)
		}
	}
	// The transfer records stay readable for the result screens; the session has ended (purge scheduled,
	// counted, open-session slot freed).
	if got := e.transfers(rx, s.ID); len(got.Transfers) != 2 || got.Transfers[0].Status != Completed {
		t.Fatalf("transfers after the end: %+v", got)
	}
	var purge *time.Time
	_ = e.pool.QueryRow(ctx, `SELECT purge_after FROM share_sessions WHERE id = $1::uuid`, s.ID).Scan(&purge)
	if purge == nil || !purge.Equal(e.clk.Now().Add(sharing.PurgeAfterEnd)) {
		t.Fatalf("purge_after: %v", purge)
	}
	m := scrape(e.reg)
	if !contains(m, "sa_sessions_completed_total 1") || !contains(m, "sa_sessions_partially_completed_total 0") {
		t.Fatalf("metrics:\n%s", m)
	}
	if _, err := e.share.Create(ctx, sender, sharing.CreateInput{Files: []sharing.FileInput{{Name: "a", Size: 1}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.share.Create(ctx, sender, sharing.CreateInput{Files: []sharing.FileInput{{Name: "b", Size: 1}}}); err != nil {
		t.Fatalf("an ended session no longer counts toward the open-session cap: %v", err)
	}
	if res := e.tick(); res.SessionsExpired != 0 {
		t.Fatalf("ended sessions are not revisited: %+v", res)
	}
}

// One failed file, or a receiver that left before finishing, makes the idle end PARTIALLY_COMPLETED.
func TestIdleEndRecordsPartial(t *testing.T) {
	t.Run("one failed file", func(t *testing.T) {
		e := newEnv(t, 1000)
		sender, rx := e.device("Minh"), e.device("Lan")
		s := e.session(sender, false)
		e.join(rx, s.Code)
		l := e.transfers(rx, s.ID)
		e.finish(rx, byFile(l, 1000), true)
		e.finish(rx, byFile(l, 10), false)
		e.wantLive(s.ID, sender.DeviceID)
		if res := e.idleEnd(); res.SessionsPartial != 1 || res.SessionsCompleted != 0 || res.SessionsExpired != 1 {
			t.Fatalf("idle tick: %+v", res)
		}
		if got := e.status(s.ID); got != sharing.StatusPartiallyCompleted {
			t.Fatalf("status: %s", got)
		}
		if !contains(scrape(e.reg), "sa_sessions_partially_completed_total 1") {
			t.Fatalf("metrics:\n%s", scrape(e.reg))
		}
	})
	t.Run("receiver left before finishing", func(t *testing.T) {
		e := newEnv(t, 1000)
		sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
		s := e.session(sender, false)
		e.join(a, s.Code)
		jb := e.join(b, s.Code)
		e.finishAll(a, s.ID)
		e.start(b, byFile(e.transfers(b, s.ID), 1000))
		if _, err := e.share.Leave(ctx, b, jb.Participant.ID); err != nil {
			t.Fatal(err)
		}
		e.wantLive(s.ID, sender.DeviceID, a.DeviceID)
		if res := e.idleEnd(); res.SessionsPartial != 1 {
			t.Fatalf("idle tick: %+v", res)
		}
		if got := e.status(s.ID); got != sharing.StatusPartiallyCompleted {
			t.Fatalf("status: %s", got)
		}
	})
}

// Removed and blocked receivers do not count toward the result, and removing them never ends the session.
func TestIdleEndExcludesRemovedAndBlocked(t *testing.T) {
	for _, action := range []string{"remove", "block"} {
		t.Run(action, func(t *testing.T) {
			e := newEnv(t, 1000)
			sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
			s := e.session(sender, false)
			e.join(a, s.Code)
			jb := e.join(b, s.Code)
			e.finishAll(a, s.ID)
			e.start(b, byFile(e.transfers(b, s.ID), 1000))
			if _, err := e.share.Decide(ctx, sender, jb.Participant.ID, action); err != nil {
				t.Fatal(err)
			}
			e.stopAccepting(sender, s.ID)
			e.wantLive(s.ID, sender.DeviceID, a.DeviceID)
			if res := e.idleEnd(); res.SessionsCompleted != 1 {
				t.Fatalf("idle tick: %+v", res)
			}
			if got := e.status(s.ID); got != sharing.StatusCompleted {
				t.Fatalf("status: %s", got)
			}
		})
	}
}

// A session that delivered nothing ends EXPIRED. Removing every receiver keeps it live, and Create new code
// still works first.
func TestIdleEndNothingDeliveredExpires(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	ja := e.join(a, s.Code)
	for _, tr := range e.transfers(a, s.ID).Transfers {
		e.finish(a, tr, false)
	}
	if _, err := e.share.Decide(ctx, sender, ja.Participant.ID, "remove"); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(sharing.JoinWindow + time.Minute)
	e.tick()
	e.wantLive(s.ID, sender.DeviceID)
	v, err := e.share.Renew(ctx, sender, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	jb := e.join(b, v.Code)
	if _, err := e.share.Decide(ctx, sender, jb.Participant.ID, "block"); err != nil {
		t.Fatal(err)
	}
	res := e.idleEnd()
	if res.SessionsExpired != 1 || res.SessionsCompleted+res.SessionsPartial != 0 {
		t.Fatalf("idle tick: %+v", res)
	}
	if got := e.status(s.ID); got != sharing.StatusExpired {
		t.Fatalf("status: %s", got)
	}
	if ev := e.note.ended(sender.DeviceID); len(ev) != 1 || ev[0].Type != "SESSION_EXPIRED" {
		t.Fatalf("notice: %+v", ev)
	}
	m := scrape(e.reg)
	if !contains(m, "sa_sessions_completed_total 0") || !contains(m, "sa_sessions_partially_completed_total 0") {
		t.Fatalf("metrics:\n%s", m)
	}
}

// The maximum lifetime ends a session mid-transfer even while everyone is connected: one receiver done and one
// still transferring is PARTIALLY_COMPLETED, and the unfinished transfer is CANCELLED in the same tick.
func TestMaxLifetimeMidTransferRecordsPartial(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	e.join(a, s.Code)
	e.join(b, s.Code)
	e.finishAll(a, s.ID)
	lb := e.transfers(b, s.ID)
	e.finish(b, byFile(lb, 10), true)
	e.start(b, byFile(lb, 1000))
	var expires time.Time
	if err := e.pool.QueryRow(ctx, `SELECT expires_at FROM share_sessions WHERE id = $1::uuid`, s.ID).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(expires.Sub(e.clk.Now()) + time.Minute)
	res := e.tick()
	if res.SessionsExpired != 1 || res.SessionsPartial != 1 {
		t.Fatalf("tick: %+v", res)
	}
	if got := e.status(s.ID); got != sharing.StatusPartiallyCompleted {
		t.Fatalf("status: %s", got)
	}
	if got := e.transfers(b, s.ID); byFile(got, 1000).Status != Cancelled || byFile(got, 10).Status != Completed {
		t.Fatalf("b's transfers: %+v", got.Transfers)
	}
	for _, dev := range []string{sender.DeviceID, a.DeviceID, b.DeviceID} {
		if ev := e.note.ended(dev); len(ev) != 1 || ev[0].Reason != "max_lifetime" {
			t.Fatalf("notice: %+v", ev)
		}
	}
	if _, err := e.svc.Report(ctx, b.DeviceID, byFile(lb, 1000).ID, Report{Status: Transferring, VerifiedBytes: 900}); err == nil {
		t.Fatal("a report after the end must be refused")
	}
}

// Close yields CLOSED whatever was delivered, and the maintenance job never changes an ended session.
func TestCloseYieldsClosed(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(a, s.Code)
	e.finish(a, byFile(e.transfers(a, s.ID), 1000), true)
	if err := e.share.Close(ctx, sender, s.ID); err != nil {
		t.Fatal(err)
	}
	e.idleEnd()
	if got := e.status(s.ID); got != sharing.StatusClosed {
		t.Fatalf("closed: %s", got)
	}
	if got := e.transfers(a, s.ID); byFile(got, 10).Status != Cancelled || byFile(got, 1000).Status != Completed {
		t.Fatalf("close cancels only unfinished transfers: %+v", got.Transfers)
	}
	e2 := newEnv(t, 1000)
	sender2, b := e2.device("Minh"), e2.device("Lan")
	s2 := e2.session(sender2, false)
	e2.join(b, s2.Code)
	e2.finishAll(b, s2.ID)
	if err := e2.share.Close(ctx, sender2, s2.ID); err != nil {
		t.Fatal(err)
	}
	if got := e2.status(s2.ID); got != sharing.StatusClosed {
		t.Fatalf("fully delivered then closed: %s", got)
	}
	if res := e2.idleEnd(); res.SessionsExpired+res.SessionsCompleted != 0 {
		t.Fatalf("tick revisited a closed session: %+v", res)
	}
}

// Five receivers sending their final reports while the maximum lifetime ends the session: the session row
// lock orders every report before or after the end, so the recorded status always matches the stored
// transfers and nothing is left unfinished.
func TestLifetimeEndRacesFinalReports(t *testing.T) {
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
		e.start(c, tr)
		last[i] = tr
	}
	var expires time.Time
	if err := e.pool.QueryRow(ctx, `SELECT expires_at FROM share_sessions WHERE id = $1::uuid`, s.ID).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(expires.Sub(e.clk.Now()) + time.Minute)
	var wg sync.WaitGroup
	for i, c := range rxs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = e.svc.Report(ctx, c.DeviceID, last[i].ID, Report{Status: Completed, VerifiedBytes: 1000})
		}()
	}
	var res sharing.TickResult
	var tickErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		res, tickErr = e.share.Tick(ctx)
	}()
	wg.Wait()
	if tickErr != nil || res.SessionsExpired != 1 {
		t.Fatalf("tick: %+v %v", res, tickErr)
	}
	var stored []string
	for _, c := range rxs {
		for _, tr := range e.transfers(c, s.ID).Transfers {
			if !Terminal(tr.Status) {
				t.Fatalf("unfinished transfer after the end: %+v", tr)
			}
			stored = append(stored, tr.Status)
		}
	}
	want := sharing.EndStatus([]sharing.ReceiverState{{Status: sharing.PJoined, Transfers: stored}})
	if got := e.status(s.ID); got != want {
		t.Fatalf("recorded %s, stored transfers say %s (%v)", got, want, stored)
	}
	if st := e.note.sessionStatuses(sender.DeviceID); count(st, sharing.StatusCompleted)+count(st, sharing.StatusPartiallyCompleted) != 0 {
		t.Fatalf("SESSION_UPDATED announced an end status: %v", st)
	}
}

// The maintenance job cancels transfers left unfinished by an ended session or a departed receiver (records
// an interrupted or older code path could leave) without ending the live session, and purges ended sessions
// with their transfers 7 days after they end (docs/SECURITY_MODEL.md §6).
func TestTickCancelsOrphansAndPurges(t *testing.T) {
	e := newEnv(t, 1000)
	sender, a, b := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	e.join(a, s.Code)
	jb := e.join(b, s.Code)
	e.stopAccepting(sender, s.ID)
	e.finishAll(a, s.ID)
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
	res := e.tick()
	if res.OrphansCancelled != 4 || res.SessionsExpired+res.SessionsCompleted+res.SessionsPartial != 0 {
		t.Fatalf("tick: %+v", res)
	}
	var open int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM transfers WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED')`).Scan(&open)
	if open != 0 {
		t.Fatalf("%d unfinished transfers remain", open)
	}
	e.wantLive(s.ID, sender.DeviceID, a.DeviceID)
	if !contains(scrape(e.reg), "sa_orphan_transfers_cancelled_total 4") {
		t.Fatalf("metrics:\n%s", scrape(e.reg))
	}
	if res := e.tick(); res.OrphansCancelled != 0 {
		t.Fatalf("second tick: %+v", res)
	}
	if err := e.share.Close(ctx, sender, s.ID); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(sharing.PurgeAfterEnd + time.Minute)
	if res := e.tick(); res.Purged != 2 {
		t.Fatalf("purge: %+v", res)
	}
	var n int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM transfers`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d transfers outlived their sessions", n)
	}
}
