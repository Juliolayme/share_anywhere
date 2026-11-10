package sharing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/migrations"
)

var ctx = context.Background()

type fakeNotify struct {
	mu        sync.Mutex
	events    map[string][]any
	broadcast []any
	connected map[string]bool
}

func (f *fakeNotify) SendToDevice(id string, v any) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events[id] = append(f.events[id], v)
	return true
}
func (f *fakeNotify) Broadcast(v any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.broadcast = append(f.broadcast, v)
}
func (f *fakeNotify) Connected(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connected[id]
}
func (f *fakeNotify) types(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, e := range f.events[id] {
		switch v := e.(type) {
		case ParticipantEvent:
			out = append(out, v.Type)
		case SessionUpdated:
			out = append(out, v.Type)
		case SessionEnded:
			out = append(out, v.Type)
		}
	}
	return out
}

type env struct {
	t      *testing.T
	pool   *pgxpool.Pool
	clk    *clock.Fake
	note   *fakeNotify
	prot   *ProtectedMode
	svc    *Service
	nextIP int
}

func newEnv(t *testing.T) *env {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	schema := "s_" + hex.EncodeToString(b)
	admin, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, _ := pgxpool.ParseConfig(url)
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 30
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})
	if _, err := db.Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	clk := clock.NewFake(time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC))
	note := &fakeNotify{events: map[string][]any{}, connected: map[string]bool{}}
	prot := NewProtectedMode(clk, 50)
	svc := NewService(Config{Pool: pool, Clock: clk, Secret: []byte("0123456789abcdef0123456789abcdef"), Notify: note,
		Limits: ScaledLimits(clk, 1), Protected: prot, PublicURL: "https://app.example", Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	return &env{t: t, pool: pool, clk: clk, note: note, prot: prot, svc: svc}
}

// device inserts an anonymous device and returns a caller with its own address.
func (e *env) device(name string) Caller {
	e.t.Helper()
	id := newID()
	if _, err := e.pool.Exec(ctx, `INSERT INTO devices (id, display_name, platform, created_at, last_seen_at, expires_at) VALUES ($1::uuid, $2, 'Web · Test', now(), now(), now() + interval '30 days')`, id, name); err != nil {
		e.t.Fatal(err)
	}
	e.nextIP++
	return Caller{DeviceID: id, IPKey: fmt.Sprintf("198.51.%d.%d", e.nextIP/250, e.nextIP%250), DisplayName: name, Platform: "Web · Test"}
}

func (e *env) create(c Caller, approval bool) SessionView {
	e.t.Helper()
	v, err := e.svc.Create(ctx, c, CreateInput{Files: []FileInput{{Name: "trip.mp4", Size: 1000, Mime: "video/mp4"}, {Name: "notes.txt", Size: 10}}, RequireApproval: approval})
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

func (e *env) joinCode(c Caller, code string) (JoinResult, error) {
	p, err := e.svc.ResolveCode(ctx, c, code)
	if err != nil {
		return JoinResult{}, err
	}
	return e.svc.Join(ctx, c, p.SessionID, p.JoinTicket)
}

func (e *env) joinLink(c Caller, token string) (JoinResult, error) {
	p, err := e.svc.ResolveLink(ctx, c, token)
	if err != nil {
		return JoinResult{}, err
	}
	return e.svc.Join(ctx, c, p.SessionID, p.JoinTicket)
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var se *Error
	if !errors.As(err, &se) || se.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func TestOpenJoinByCodeAndLinkAndSignalingScope(t *testing.T) {
	e := newEnv(t)
	sender := e.device("Minh’s laptop")
	s := e.create(sender, false)
	if s.Code == "" || s.LinkToken == "" || s.JoinURL != "https://app.example/j/"+s.LinkToken || s.JoinWindow.State != WindowOpen {
		t.Fatalf("sender view: %+v", s)
	}
	if got := s.JoinWindow.EndsAt.Sub(s.JoinWindow.OpenedAt); got != JoinWindow {
		t.Fatalf("window is %v", got)
	}
	rx := e.device("Lan’s phone")
	// Before joining, the receiver cannot signal and cannot get TURN credentials.
	senderPID := s.Participants
	_ = senderPID
	prev, err := e.svc.ResolveCode(ctx, rx, s.Code)
	if err != nil {
		t.Fatal(err)
	}
	if prev.Sender.DisplayName != "Minh’s laptop" || prev.FileCount != 2 || prev.TotalBytes != 1010 || prev.Via != "code" {
		t.Fatalf("preview %+v", prev)
	}
	if _, _, err := e.svc.SignalRoute(ctx, rx.DeviceID, s.ID, prev.Sender.ParticipantID); err == nil {
		t.Fatal("no signaling before JOINED")
	}
	if _, err := e.svc.View(ctx, rx.DeviceID, s.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no session view before joining: %v", err)
	}
	res, err := e.svc.Join(ctx, rx, prev.SessionID, prev.JoinTicket)
	if err != nil {
		t.Fatal(err)
	}
	if res.Participant.Status != PJoined || len(res.Participant.SecurityWords) != 3 || res.Participant.JoinedVia != "code" {
		t.Fatalf("join: %+v", res.Participant)
	}
	// Same words on both sides.
	sv, _ := e.svc.View(ctx, sender.DeviceID, s.ID)
	if sv.Status != StatusActive || len(sv.Participants) != 1 || fmt.Sprint(sv.Participants[0].SecurityWords) != fmt.Sprint(res.Participant.SecurityWords) {
		t.Fatalf("sender view after join: %+v", sv)
	}
	if got := e.note.types(sender.DeviceID); len(got) == 0 || got[0] != "PARTICIPANT_JOINED" {
		t.Fatalf("sender events %v", got)
	}
	// Signaling only along the sender–receiver pair, both directions.
	from, to, err := e.svc.SignalRoute(ctx, rx.DeviceID, s.ID, prev.Sender.ParticipantID)
	if err != nil || to != sender.DeviceID || from != res.Participant.ID {
		t.Fatalf("receiver→sender: %v %v %v", from, to, err)
	}
	if _, to, err := e.svc.SignalRoute(ctx, sender.DeviceID, s.ID, res.Participant.ID); err != nil || to != rx.DeviceID {
		t.Fatalf("sender→receiver: %v", err)
	}
	if _, err := e.svc.TurnParticipant(ctx, rx.DeviceID, s.ID); err != nil {
		t.Fatalf("joined receiver gets TURN: %v", err)
	}
	// Joined receiver view has files but no code.
	rv, _ := e.svc.View(ctx, rx.DeviceID, s.ID)
	if rv.Code != "" || rv.LinkToken != "" || len(rv.Files) != 2 || rv.Sender == nil || rv.Me.Status != PJoined {
		t.Fatalf("receiver view %+v", rv)
	}
	// Link join works the same way.
	rx2 := e.device("Office PC")
	r2, err := e.joinLink(rx2, s.LinkToken)
	if err != nil || r2.Participant.Status != PJoined || r2.Participant.JoinedVia != "link" {
		t.Fatalf("link join: %+v %v", r2, err)
	}
	// Two receivers may not signal each other.
	if _, _, err := e.svc.SignalRoute(ctx, rx.DeviceID, s.ID, r2.Participant.ID); err == nil {
		t.Fatal("receivers must not signal each other")
	}
	// Joining again is idempotent.
	again, err := e.joinCode(rx, s.Code)
	if err != nil || again.Participant.ID != res.Participant.ID {
		t.Fatalf("idempotent join: %v", err)
	}
	if _, err := e.svc.ResolveCode(ctx, sender, s.Code); err == nil {
		t.Fatal("the sender cannot join its own session")
	}
}

func TestApprovalFlowAndToggleAffectsOnlyLaterJoins(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, true)
	a := e.device("A")
	ra, err := e.joinCode(a, s.Code)
	if err != nil || ra.Participant.Status != PRequested || ra.Participant.RequestReason != "approval" {
		t.Fatalf("requested: %+v %v", ra, err)
	}
	if _, _, err := e.svc.SignalRoute(ctx, a.DeviceID, s.ID, ra.Participant.ID); err == nil {
		t.Fatal("REQUESTED cannot signal")
	}
	if _, err := e.svc.TurnParticipant(ctx, a.DeviceID, s.ID); err == nil {
		t.Fatal("REQUESTED cannot get TURN")
	}
	if v, _ := e.svc.View(ctx, a.DeviceID, s.ID); v.Me.Status != PRequested || len(v.Files) == 0 {
		t.Fatalf("requested receiver sees preview and own status: %+v", v)
	}
	if _, err := e.svc.Decide(ctx, a, ra.Participant.ID, "approve"); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrForbidden) {
		t.Fatalf("only the sender approves: %v", err)
	}
	p, err := e.svc.Decide(ctx, sender, ra.Participant.ID, "approve")
	if err != nil || p.Status != PJoined {
		t.Fatalf("approve: %+v %v", p, err)
	}
	if got := e.note.types(a.DeviceID); len(got) == 0 || got[0] != "PARTICIPANT_APPROVED" {
		t.Fatalf("receiver told: %v", got)
	}
	b := e.device("B")
	rb, _ := e.joinCode(b, s.Code)
	if p, err := e.svc.Decide(ctx, sender, rb.Participant.ID, "reject"); err != nil || p.Status != PRejected {
		t.Fatalf("reject: %v", err)
	}
	if _, err := e.svc.Decide(ctx, sender, rb.Participant.ID, "approve"); err == nil {
		t.Fatal("cannot approve a rejected receiver")
	}
	// Turning approval off admits later joiners directly; earlier ones keep their status.
	off := false
	if _, err := e.svc.Update(ctx, sender, s.ID, UpdateInput{RequireApproval: &off}); err != nil {
		t.Fatal(err)
	}
	c := e.device("C")
	if rc, err := e.joinCode(c, s.Code); err != nil || rc.Participant.Status != PJoined {
		t.Fatalf("after toggle: %+v %v", rc, err)
	}
	on := true
	_, _ = e.svc.Update(ctx, sender, s.ID, UpdateInput{RequireApproval: &on})
	if v, _ := e.svc.View(ctx, c.DeviceID, s.ID); v.Me.Status != PJoined {
		t.Fatal("toggling approval on must not affect joined receivers")
	}
}

func TestProtectedModeForcesApprovalForCodeJoinsOnly(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, false)
	// Drive the global failed-lookup counter over the threshold (50) from many devices and addresses.
	for i := 0; i < 50; i++ {
		_, err := e.svc.ResolveCode(ctx, e.device(fmt.Sprintf("g%d", i)), "000000")
		if err == nil && s.Code == "000000" {
			continue
		}
	}
	if on, _ := e.prot.Active(); !on {
		t.Fatal("protected mode should be on")
	}
	if len(e.note.broadcast) == 0 {
		t.Fatal("PROTECTED_MODE broadcast expected")
	}
	a := e.device("A")
	prev, _ := e.svc.ResolveCode(ctx, a, s.Code)
	if !prev.ProtectedMode {
		t.Fatal("preview must say protected mode applies")
	}
	ra, err := e.svc.Join(ctx, a, prev.SessionID, prev.JoinTicket)
	if err != nil || ra.Participant.Status != PRequested || ra.Participant.RequestReason != "protected_mode" {
		t.Fatalf("code join in protected mode: %+v %v", ra, err)
	}
	b := e.device("B")
	if rb, err := e.joinLink(b, s.LinkToken); err != nil || rb.Participant.Status != PJoined {
		t.Fatalf("link join unaffected: %+v %v", rb, err)
	}
	e.clk.Advance(ProtectedDuration + time.Second)
	if on, _ := e.prot.Active(); on {
		t.Fatal("protected mode ends after 30 minutes")
	}
	if _, err := e.svc.Tick(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestFiveReceiverCapUnderConcurrency(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, false)
	type prepared struct {
		c Caller
		p Preview
	}
	var ready []prepared
	for i := 0; i < 20; i++ {
		c := e.device(fmt.Sprintf("r%d", i))
		p, err := e.svc.ResolveLink(ctx, c, s.LinkToken)
		if err != nil {
			t.Fatal(err)
		}
		ready = append(ready, prepared{c, p})
	}
	var wg sync.WaitGroup
	results := make([]error, len(ready))
	start := make(chan struct{})
	for i, r := range ready {
		wg.Add(1)
		go func(i int, r prepared) {
			defer wg.Done()
			<-start
			_, results[i] = e.svc.Join(ctx, r.c, r.p.SessionID, r.p.JoinTicket)
		}(i, r)
	}
	close(start)
	wg.Wait()
	ok := 0
	for _, err := range results {
		if err == nil {
			ok++
			continue
		}
		wantCode(t, err, "session_full")
	}
	if ok != MaxReceivers {
		t.Fatalf("exactly %d joins must succeed, got %d", MaxReceivers, ok)
	}
	v, _ := e.svc.View(ctx, sender.DeviceID, s.ID)
	if v.Capacity.Joined != 5 || v.JoinWindow.State != WindowEndedFull {
		t.Fatalf("after race: %+v %+v", v.Capacity, v.JoinWindow)
	}
}

func TestRemoveFreesSlotAndBlockCoversDeviceAndAddress(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, false)
	a := e.device("A")
	ra, _ := e.joinCode(a, s.Code)
	if _, err := e.svc.Decide(ctx, sender, ra.Participant.ID, "remove"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.SignalRoute(ctx, a.DeviceID, s.ID, ra.Participant.ID); err == nil {
		t.Fatal("removed receiver loses signaling")
	}
	if v, _ := e.svc.View(ctx, a.DeviceID, s.ID); v.Me.Status != PRemoved || len(v.Files) != 0 {
		t.Fatalf("removed receiver sees only its status: %+v", v)
	}
	if v, _ := e.svc.View(ctx, sender.DeviceID, s.ID); v.Capacity.Joined != 0 {
		t.Fatal("slot freed")
	}
	// A removed receiver may come back with a valid code; a blocked one may not.
	if r, err := e.joinCode(a, s.Code); err != nil || r.Participant.Status != PJoined {
		t.Fatalf("rejoin after remove: %v", err)
	}
	if _, err := e.svc.Decide(ctx, sender, ra.Participant.ID, "block"); err != nil {
		t.Fatal(err)
	}
	_, err := e.joinCode(a, s.Code)
	wantCode(t, err, "blocked")
	// A fresh anonymous identity on the same address /64 is refused too.
	fresh := e.device("A again")
	fresh.IPKey = a.IPKey
	_, err = e.joinCode(fresh, s.Code)
	wantCode(t, err, "blocked")
}

func TestJoinWindowLifecycle(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, false)
	early := e.device("early")
	ticket98, err := e.svc.ResolveCode(ctx, e.device("slow"), s.Code)
	if err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(9*time.Minute + 58*time.Second)
	slow := e.device("slow2")
	p98, _ := e.svc.ResolveCode(ctx, slow, s.Code)
	if !p98.TicketExpiresAt.Equal(s.JoinWindow.EndsAt) {
		t.Fatal("a ticket never outlives the window")
	}
	e.clk.Advance(time.Second) // 9:59
	if r, err := e.joinCode(early, s.Code); err != nil || r.Participant.Status != PJoined {
		t.Fatalf("join at 9:59: %v", err)
	}
	e.clk.Advance(time.Second) // 10:00
	_, err = e.svc.ResolveCode(ctx, e.device("late"), s.Code)
	wantCode(t, err, "join_window_expired")
	_, err = e.svc.ResolveLink(ctx, e.device("late2"), s.LinkToken)
	wantCode(t, err, "join_window_expired")
	_, err = e.svc.Join(ctx, slow, p98.SessionID, p98.JoinTicket)
	wantCode(t, err, "join_window_expired")
	_ = ticket98
	// The receiver who joined keeps signaling and TURN; the session stays ACTIVE.
	if _, err := e.svc.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	v, _ := e.svc.View(ctx, sender.DeviceID, s.ID)
	if v.Status != StatusActive || v.JoinWindow.State != WindowExpired || v.Code != "" {
		t.Fatalf("after expiry: status %s window %s code %q", v.Status, v.JoinWindow.State, v.Code)
	}
	if _, err := e.svc.TurnParticipant(ctx, early.DeviceID, s.ID); err != nil {
		t.Fatalf("joined receiver keeps TURN after expiry: %v", err)
	}
	// Create new code: new code and link, fresh 10:00; the old ones fail at once.
	oldCode, oldLink := s.Code, s.LinkToken
	n, err := e.svc.Renew(ctx, sender, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n.LinkToken == oldLink || n.JoinWindow.State != WindowOpen || n.JoinWindow.EndsAt.Sub(n.JoinWindow.OpenedAt) != JoinWindow || n.JoinWindow.Seq != 2 {
		t.Fatalf("renew: %+v", n.JoinWindow)
	}
	if n.Code == oldCode {
		t.Log("new code equals the old one by chance (1 in 10^6)")
	} else {
		_, err = e.svc.ResolveCode(ctx, e.device("old"), oldCode)
		if err == nil {
			t.Fatal("old code must fail after renew")
		}
	}
	_, err = e.svc.ResolveLink(ctx, e.device("old2"), oldLink)
	wantCode(t, err, "join_window_expired")
	if r, err := e.joinCode(e.device("new"), n.Code); err != nil || r.Participant.Status != PJoined {
		t.Fatalf("join with new code: %v", err)
	}
	// Stop accepting ends the window now.
	f := false
	if _, err := e.svc.Update(ctx, sender, s.ID, UpdateInput{AcceptingReceivers: &f}); err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.ResolveCode(ctx, e.device("x"), n.Code)
	wantCode(t, err, "session_not_accepting")
	_, err = e.svc.ResolveLink(ctx, e.device("y"), n.LinkToken)
	wantCode(t, err, "session_not_accepting")
}

func TestRenewWhileFullAndApprovalAfterExpiry(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, true)
	var first JoinResult
	for i := 0; i < 5; i++ {
		r, err := e.joinCode(e.device(fmt.Sprintf("r%d", i)), s.Code)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = r
		}
	}
	_, err := e.svc.Renew(ctx, sender, s.ID)
	wantCode(t, err, "session_full")
	_, err = e.joinCode(e.device("sixth"), s.Code)
	wantCode(t, err, "session_full")
	// A request made inside the window stays approvable after the window ended.
	e.clk.Advance(JoinWindow + time.Minute)
	_, _ = e.svc.Tick(ctx)
	if p, err := e.svc.Decide(ctx, sender, first.Participant.ID, "approve"); err != nil || p.Status != PJoined {
		t.Fatalf("approve after expiry: %v", err)
	}
	// Removing someone frees a slot, and Create new code works again.
	v, _ := e.svc.View(ctx, sender.DeviceID, s.ID)
	var pending string
	for _, p := range v.Participants {
		if p.Status == PRequested {
			pending = p.ID
			break
		}
	}
	if _, err := e.svc.Decide(ctx, sender, pending, "reject"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Renew(ctx, sender, s.ID); err != nil {
		t.Fatalf("renew after a slot freed: %v", err)
	}
}

func TestLookupLimitsAndLockouts(t *testing.T) {
	e := newEnv(t)
	// Per address: 10 failed lookups per hour from many devices, then a 30-minute lockout.
	ip := "203.0.113.9"
	var err error
	for i := 0; i < 12; i++ {
		c := e.device(fmt.Sprintf("d%d", i))
		c.IPKey = ip
		e.clk.Advance(7 * time.Second) // stay under the per-minute lookup limit
		_, err = e.svc.ResolveCode(ctx, c, "999999")
	}
	var se *Error
	if !errors.As(err, &se) || se.Code != "locked_out" || se.Wait <= 0 {
		t.Fatalf("address lockout: %v", err)
	}
	// Per device: 5 failures in 10 minutes.
	d := e.device("solo")
	for i := 0; i < 7; i++ {
		e.clk.Advance(13 * time.Second)
		_, err = e.svc.ResolveCode(ctx, d, "999998")
	}
	wantCode(t, err, "locked_out")
	e.clk.Advance(LockoutDuration + time.Minute)
	_, err = e.svc.ResolveCode(ctx, d, "999998")
	wantCode(t, err, "code_not_found")
	// Malformed codes are rejected without counting.
	_, err = e.svc.ResolveCode(ctx, d, "12ab56")
	wantCode(t, err, "invalid_request")
}

func TestCreationLimitsAndOpenSessionCap(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	e.create(sender, false)
	e.create(sender, false)
	_, err := e.svc.Create(ctx, sender, CreateInput{Files: []FileInput{{Name: "a", Size: 1}}})
	wantCode(t, err, "too_many_open_sessions")
	_, err = e.svc.Create(ctx, e.device("big"), CreateInput{Files: []FileInput{{Name: "a", Size: MaxSessionBytes + 1}}})
	wantCode(t, err, "over_limit")
	_, err = e.svc.Create(ctx, e.device("none"), CreateInput{})
	wantCode(t, err, "invalid_request")
	// Per device: 10 creations per hour.
	busy := e.device("busy")
	for i := 0; i < 10; i++ {
		v, err := e.svc.Create(ctx, busy, CreateInput{Files: []FileInput{{Name: "a", Size: 1}}})
		if err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
		if err := e.svc.Close(ctx, busy, v.ID); err != nil {
			t.Fatal(err)
		}
	}
	_, err = e.svc.Create(ctx, busy, CreateInput{Files: []FileInput{{Name: "a", Size: 1}}})
	wantCode(t, err, "rate_limited")
}

func TestTurnAuthorization(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, false)
	if _, err := e.svc.TurnParticipant(ctx, sender.DeviceID, s.ID); err == nil {
		t.Fatal("no TURN before the session is ACTIVE")
	}
	a := e.device("A")
	if _, err := e.svc.TurnParticipant(ctx, a.DeviceID, s.ID); err == nil {
		t.Fatal("no TURN for a non-participant")
	}
	_, _ = e.joinCode(a, s.Code)
	if _, err := e.svc.TurnParticipant(ctx, sender.DeviceID, s.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Close(ctx, sender, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.TurnParticipant(ctx, a.DeviceID, s.ID); err == nil {
		t.Fatal("no TURN after the session ended")
	}
	if got := e.note.types(a.DeviceID); got[len(got)-1] != "SESSION_CLOSED" {
		t.Fatalf("receiver told about close: %v", got)
	}
}

func TestLifetimesIdleAndPurge(t *testing.T) {
	e := newEnv(t)
	// A session whose window ended with nobody in stays WAITING while its sender is connected.
	sender := e.device("S")
	s := e.create(sender, false)
	e.note.connected[sender.DeviceID] = true
	e.clk.Advance(JoinWindow + time.Minute)
	_, _ = e.svc.Tick(ctx)
	e.clk.Advance(45 * time.Minute)
	_, _ = e.svc.Tick(ctx)
	if v, _ := e.svc.View(ctx, sender.DeviceID, s.ID); v.Status != StatusWaiting || v.JoinWindow.State != WindowExpired {
		t.Fatalf("stays WAITING: %s %s", v.Status, v.JoinWindow.State)
	}
	// Idle: nobody connected for 30 minutes.
	e.note.connected[sender.DeviceID] = false
	e.clk.Advance(IdleTimeout + time.Minute)
	res, err := e.svc.Tick(ctx)
	if err != nil || res.SessionsExpired != 1 {
		t.Fatalf("idle expiry: %+v %v", res, err)
	}
	if v, _ := e.svc.View(ctx, sender.DeviceID, s.ID); v.Status != StatusExpired {
		t.Fatalf("expired: %s", v.Status)
	}
	// Maximum lifetime: 24 h for a guest sender even while connected.
	s2 := e.create(e.device("S2"), false)
	var owner string
	_ = e.pool.QueryRow(ctx, `SELECT owner_device_id::text FROM share_sessions WHERE id = $1::uuid`, s2.ID).Scan(&owner)
	e.note.connected[owner] = true
	for i := 0; i < 25; i++ {
		e.clk.Advance(time.Hour)
		_, _ = e.svc.Tick(ctx)
	}
	var status string
	_ = e.pool.QueryRow(ctx, `SELECT status FROM share_sessions WHERE id = $1::uuid`, s2.ID).Scan(&status)
	if status != StatusExpired {
		t.Fatalf("max lifetime: %s", status)
	}
	// Purge 7 days after the end.
	e.clk.Advance(PurgeAfterEnd + time.Hour)
	res, _ = e.svc.Tick(ctx)
	var n int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM share_sessions`).Scan(&n)
	if res.Purged < 2 || n != 0 {
		t.Fatalf("purge: %+v remaining %d", res, n)
	}
}

func TestRenewRateLimitAndRevokedTickets(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, false)
	// A ticket from the old window fails after Create new code, and after Stop accepting.
	rx := e.device("rx")
	p, _ := e.svc.ResolveCode(ctx, rx, s.Code)
	if _, err := e.svc.Renew(ctx, sender, s.ID); err != nil {
		t.Fatal(err)
	}
	_, err := e.svc.Join(ctx, rx, p.SessionID, p.JoinTicket)
	wantCode(t, err, "join_ticket_invalid")
	v, _ := e.svc.View(ctx, sender.DeviceID, s.ID)
	p2, _ := e.svc.ResolveCode(ctx, rx, v.Code)
	f := false
	_, _ = e.svc.Update(ctx, sender, s.ID, UpdateInput{AcceptingReceivers: &f})
	_, err = e.svc.Join(ctx, rx, p2.SessionID, p2.JoinTicket)
	wantCode(t, err, "join_ticket_invalid")
	// After Stop accepting, the current link says "not accepting", not "expired".
	_, err = e.svc.ResolveLink(ctx, e.device("l"), v.LinkToken)
	wantCode(t, err, "session_not_accepting")
	// Create new code: 20 per hour per device (one used above).
	for i := 0; i < 19; i++ {
		if _, err := e.svc.Renew(ctx, sender, s.ID); err != nil {
			t.Fatalf("renew %d: %v", i, err)
		}
	}
	_, err = e.svc.Renew(ctx, sender, s.ID)
	wantCode(t, err, "rate_limited")
}

func TestLinkAt959RenewAfterRemoveSignalingAfterExpiry(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, false)
	var joined []JoinResult
	for i := 0; i < 4; i++ {
		r, err := e.joinCode(e.device(fmt.Sprintf("r%d", i)), s.Code)
		if err != nil {
			t.Fatal(err)
		}
		joined = append(joined, r)
	}
	e.clk.Advance(9*time.Minute + 59*time.Second)
	viaLink := e.device("link")
	r5, err := e.joinLink(viaLink, s.LinkToken)
	if err != nil || r5.Participant.Status != PJoined {
		t.Fatalf("link at 9:59: %v", err)
	}
	_, err = e.svc.Renew(ctx, sender, s.ID)
	wantCode(t, err, "session_full")
	if _, err := e.svc.Decide(ctx, sender, joined[0].Participant.ID, "remove"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Renew(ctx, sender, s.ID); err != nil {
		t.Fatalf("renew after Remove: %v", err)
	}
	// Past the (new) window, joined receivers still signal with the sender.
	e.clk.Advance(JoinWindow + time.Minute)
	_, _ = e.svc.Tick(ctx)
	sv, _ := e.svc.View(ctx, sender.DeviceID, s.ID)
	if sv.JoinWindow.State != WindowExpired {
		t.Fatalf("window %s", sv.JoinWindow.State)
	}
	rv, _ := e.svc.View(ctx, viaLink.DeviceID, s.ID)
	if _, to, err := e.svc.SignalRoute(ctx, viaLink.DeviceID, s.ID, rv.Sender.ParticipantID); err != nil || to != sender.DeviceID {
		t.Fatalf("signaling after expiry: %v", err)
	}
}

func TestCreationIPLimitAndSignedInLifetime(t *testing.T) {
	e := newEnv(t)
	ip := "192.0.2.77"
	var err error
	for i := 0; i < 31; i++ {
		c := e.device(fmt.Sprintf("d%d", i))
		c.IPKey = ip
		_, err = e.svc.Create(ctx, c, CreateInput{Files: []FileInput{{Name: "a", Size: 1}}})
		if i < 30 && err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	wantCode(t, err, "rate_limited")
	// A signed-in sender gets 72 hours and up to 5 open sessions (accounts arrive in Phase 5A).
	acct := e.device("acct")
	acct.SignedIn = true
	var last SessionView
	for i := 0; i < 5; i++ {
		if last, err = e.svc.Create(ctx, acct, CreateInput{Files: []FileInput{{Name: "a", Size: 1}}}); err != nil {
			t.Fatalf("signed-in session %d: %v", i, err)
		}
	}
	if got := last.ExpiresAt.Sub(last.JoinWindow.OpenedAt); got != AccountLifetime {
		t.Fatalf("signed-in lifetime %v", got)
	}
	_, err = e.svc.Create(ctx, acct, CreateInput{Files: []FileInput{{Name: "a", Size: 1}}})
	wantCode(t, err, "too_many_open_sessions")
	e.note.connected[acct.DeviceID] = true
	e.clk.Advance(48 * time.Hour)
	_, _ = e.svc.Tick(ctx)
	if v, _ := e.svc.View(ctx, acct.DeviceID, last.ID); v.Status != StatusWaiting {
		t.Fatalf("still alive at 48 h: %s", v.Status)
	}
	e.clk.Advance(25 * time.Hour)
	_, _ = e.svc.Tick(ctx)
	if v, _ := e.svc.View(ctx, acct.DeviceID, last.ID); v.Status != StatusExpired {
		t.Fatalf("expired after 72 h: %s", v.Status)
	}
}

func TestStoredAddressesAreHashedAndMetricsCount(t *testing.T) {
	e := newEnv(t)
	sender := e.device("S")
	s := e.create(sender, false)
	rx := e.device("rx")
	r, _ := e.joinCode(rx, s.Code)
	if _, err := e.svc.Decide(ctx, sender, r.Participant.ID, "block"); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := e.pool.QueryRow(ctx, `SELECT ip_hash FROM session_blocks WHERE session_id = $1::uuid`, s.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == "" || stored == rx.IPKey || len(stored) != 32 {
		t.Fatalf("block must store a keyed hash, got %q (raw %q)", stored, rx.IPKey)
	}
	var raw int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM session_participants WHERE ip_hash = $1`, rx.IPKey).Scan(&raw)
	if raw != 0 {
		t.Fatal("participants must not store raw address keys")
	}
	_, _ = e.svc.ResolveCode(ctx, e.device("x"), "999997")
	if e.svc.m.sessionsCreated.Value() != 1 || e.svc.m.joins.Value() != 1 || e.svc.m.blocks.Value() != 1 || e.svc.m.lookupsFailed.Value() != 1 {
		t.Fatalf("metrics: created %d joins %d blocks %d failed %d", e.svc.m.sessionsCreated.Value(), e.svc.m.joins.Value(), e.svc.m.blocks.Value(), e.svc.m.lookupsFailed.Value())
	}
	e.svc.LockDeviceForTest(rx.DeviceID, LockoutDuration)
	_, err := e.svc.ResolveCode(ctx, rx, s.Code)
	wantCode(t, err, "locked_out")
}

func TestListOpenReturnsOnlyOwnLiveSessions(t *testing.T) {
	e := newEnv(t)
	a, b, rx := e.device("A"), e.device("B"), e.device("rx")
	ids := func(l OpenSessionList) []string {
		out := []string{}
		for _, s := range l.Sessions {
			out = append(out, s.ID)
		}
		return out
	}
	s1 := e.create(a, false)
	e.clk.Advance(time.Minute)
	s2 := e.create(a, false)
	other := e.create(b, false)
	if _, err := e.joinCode(rx, s2.Code); err != nil {
		t.Fatal(err)
	}
	l, err := e.svc.ListOpen(ctx, a.DeviceID, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(l); len(got) != 2 || got[0] != s2.ID || got[1] != s1.ID {
		t.Fatalf("own live sessions newest first: %v", got)
	}
	if l.MaxOpen != GuestOpenSessions {
		t.Fatalf("max_open %d", l.MaxOpen)
	}
	top := l.Sessions[0]
	if top.Status != StatusActive || top.FileCount != 2 || top.TotalBytes != 1010 || top.FirstFile != "trip.mp4" ||
		top.Capacity != (Capacity{Joined: 1, Max: MaxReceivers}) || top.JoinWindow.State != WindowOpen || !top.CreatedAt.Equal(s2.ServerTime) {
		t.Fatalf("item: %+v", top)
	}
	// The cap and the list agree: the third create fails while both are listed.
	_, err = e.svc.Create(ctx, a, CreateInput{Files: []FileInput{{Name: "x", Size: 1}}})
	wantCode(t, err, "too_many_open_sessions")
	// Receivers and other senders see none of A's sessions.
	if l, _ := e.svc.ListOpen(ctx, rx.DeviceID, false); len(l.Sessions) != 0 {
		t.Fatalf("receiver lists %v", ids(l))
	}
	if l, _ := e.svc.ListOpen(ctx, b.DeviceID, true); len(l.Sessions) != 1 || l.Sessions[0].ID != other.ID || l.MaxOpen != AcctOpenSessions {
		t.Fatalf("other device: %v max %d", ids(l), l.MaxOpen)
	}
	// Closed and expired sessions drop out; an expired join window alone does not.
	if err := e.svc.Close(ctx, a, s1.ID); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(JoinWindow + time.Minute)
	s3 := e.create(a, false)
	if _, err := e.pool.Exec(ctx, `UPDATE share_sessions SET status = 'EXPIRED', ended_at = $2 WHERE id = $1::uuid`, s3.ID, e.clk.Now()); err != nil {
		t.Fatal(err)
	}
	l, _ = e.svc.ListOpen(ctx, a.DeviceID, false)
	if got := ids(l); len(got) != 1 || got[0] != s2.ID || l.Sessions[0].JoinWindow.State != WindowExpired {
		t.Fatalf("after close and expiry: %v %+v", got, l.Sessions)
	}
	// Past its maximum lifetime a session is no longer listed (nor counted), even before the job ends it.
	e.clk.Advance(GuestLifetime)
	if l, _ := e.svc.ListOpen(ctx, a.DeviceID, false); len(l.Sessions) != 0 {
		t.Fatalf("over-age listed: %v", ids(l))
	}
}
