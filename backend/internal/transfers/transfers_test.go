package transfers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/metrics"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
	"github.com/juliolayme/share_anywhere/backend/migrations"
)

var ctx = context.Background()

type notes struct {
	mu sync.Mutex
	ev map[string][]any
}

func (n *notes) SendToDevice(id string, v any) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.ev[id] = append(n.ev[id], v)
	return true
}
func (n *notes) Broadcast(any)         {}
func (n *notes) Connected(string) bool { return true }
func (n *notes) updates(id string) (out []Transfer) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, e := range n.ev[id] {
		if v, ok := e.(Event); ok && v.Type == "TRANSFER_UPDATED" {
			out = append(out, v.Transfer)
		}
	}
	return out
}

type env struct {
	t     *testing.T
	pool  *pgxpool.Pool
	share *sharing.Service
	svc   *Service
	note  *notes
	reg   *metrics.Registry
	clk   *clock.Fake
	n     int
}

func newEnv(t *testing.T, reportLimit int) *env {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	schema := "t_" + hex.EncodeToString(b)
	admin, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, _ := pgxpool.ParseConfig(url)
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
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
	note := &notes{ev: map[string][]any{}}
	reg := metrics.New()
	share := sharing.NewService(sharing.Config{Pool: pool, Clock: clk, Secret: []byte("0123456789abcdef0123456789abcdef"), Notify: note,
		Limits: sharing.ScaledLimits(clk, 10), Protected: sharing.NewProtectedMode(clk, 50), PublicURL: "https://app.example",
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	svc := New(Config{Pool: pool, Clock: clk, Sessions: share, Notify: note, Metrics: reg,
		ReportLimit: ratelimit.New(ratelimit.Rule{Limit: reportLimit, Window: time.Minute}, clk)})
	return &env{t: t, pool: pool, share: share, svc: svc, note: note, reg: reg, clk: clk}
}

func (e *env) device(name string) sharing.Caller {
	e.t.Helper()
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = (b[6]&0x0f)|0x40, (b[8]&0x3f)|0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	if _, err := e.pool.Exec(ctx, `INSERT INTO devices (id, display_name, platform, created_at, last_seen_at, expires_at) VALUES ($1::uuid, $2, 'Web · Test', now(), now(), now() + interval '30 days')`, id, name); err != nil {
		e.t.Fatal(err)
	}
	e.n++
	return sharing.Caller{DeviceID: id, IPKey: fmt.Sprintf("198.51.100.%d", e.n), DisplayName: name, Platform: "Web · Test"}
}

func (e *env) session(sender sharing.Caller, approval bool) sharing.SessionView {
	e.t.Helper()
	v, err := e.share.Create(ctx, sender, sharing.CreateInput{Files: []sharing.FileInput{{Name: "trip.mp4", Size: 1000, Mime: "video/mp4"}, {Name: "notes.txt", Size: 10}}, RequireApproval: approval})
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

func (e *env) join(c sharing.Caller, code string) sharing.JoinResult {
	e.t.Helper()
	p, err := e.share.ResolveCode(ctx, c, code)
	if err != nil {
		e.t.Fatal(err)
	}
	r, err := e.share.Join(ctx, c, p.SessionID, p.JoinTicket)
	if err != nil {
		e.t.Fatal(err)
	}
	return r
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var te *Error
	var se *sharing.Error
	switch {
	case errors.As(err, &te) && te.Code == code, errors.As(err, &se) && se.Code == code:
	default:
		t.Fatalf("want %s, got %v", code, err)
	}
}

func byFile(l List, size int64) Transfer {
	for _, t := range l.Transfers {
		if t.Size == size {
			return t
		}
	}
	return Transfer{}
}

func TestListScopesAndCapability(t *testing.T) {
	e := newEnv(t, 1000)
	sender, rx, other := e.device("Minh"), e.device("Lan"), e.device("Huy")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	e.join(other, s.Code)

	sl, err := e.svc.List(ctx, sender.DeviceID, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if sl.Role != "sender" || len(sl.Transfers) != 4 || len(sl.Peers) != 2 || sl.Capability != "" {
		t.Fatalf("sender list: %+v", sl)
	}
	rl, err := e.svc.List(ctx, rx.DeviceID, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rl.Role != "receiver" || len(rl.Transfers) != 2 || len(rl.Peers) != 0 || len(rl.Capability) < 40 {
		t.Fatalf("receiver list: %+v", rl)
	}
	for _, tr := range rl.Transfers {
		if tr.Status != Pending || tr.ParticipantID != rl.Transfers[0].ParticipantID {
			t.Fatalf("receiver sees only its own pending transfers: %+v", tr)
		}
	}
	sum := sha256.Sum256([]byte(rl.Capability))
	found := false
	for _, p := range sl.Peers {
		if p.ParticipantID == rl.Transfers[0].ParticipantID {
			found = p.CapabilityHash == hex.EncodeToString(sum[:])
		}
	}
	if !found {
		t.Fatal("the sender's capability hash must match the receiver's capability")
	}
	// Another receiver's transfer does not exist for this receiver; strangers see nothing.
	ol, _ := e.svc.List(ctx, other.DeviceID, s.ID)
	if _, err := e.svc.Get(ctx, rx.DeviceID, ol.Transfers[0].ID); !errors.Is(err, errNotFound) {
		t.Fatalf("cross-receiver get: %v", err)
	}
	stranger := e.device("Stranger")
	if _, err := e.svc.List(ctx, stranger.DeviceID, s.ID); err == nil {
		t.Fatal("stranger list")
	}
	if _, err := e.svc.Report(ctx, stranger.DeviceID, ol.Transfers[0].ID, Report{Status: Connecting}); !errors.Is(err, errNotFound) {
		t.Fatalf("stranger report: %v", err)
	}
	files, err := e.svc.Files(ctx, rx.DeviceID, s.ID)
	if err != nil || len(files) != 2 {
		t.Fatalf("files: %v %v", files, err)
	}
	if _, err := e.svc.Files(ctx, stranger.DeviceID, s.ID); err == nil {
		t.Fatal("stranger files")
	}
}

func TestRequestedReceiverSeesNoTransfers(t *testing.T) {
	e := newEnv(t, 1000)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, true)
	r := e.join(rx, s.Code)
	if r.Participant.Status != sharing.PRequested {
		t.Fatalf("want REQUESTED, got %s", r.Participant.Status)
	}
	if _, err := e.svc.List(ctx, rx.DeviceID, s.ID); !errors.Is(err, errNotFound) {
		t.Fatalf("requested list: %v", err)
	}
	if _, err := e.svc.Files(ctx, rx.DeviceID, s.ID); !errors.Is(err, errNotFound) {
		t.Fatalf("requested files: %v", err)
	}
}

func TestReportStateMachine(t *testing.T) {
	e := newEnv(t, 1000)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	l, _ := e.svc.List(ctx, rx.DeviceID, s.ID)
	tr := byFile(l, 1000)
	route := "direct"
	bad := "carrier-pigeon"

	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: "DONE"})), "invalid_status")
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Connecting, Route: &bad})), "invalid_route")
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Completed, VerifiedBytes: 1000})), "invalid_transition")
	steps := []Report{{Status: Connecting}, {Status: Transferring, VerifiedBytes: 100, Route: &route}, {Status: Transferring, VerifiedBytes: 400}}
	for _, r := range steps {
		if _, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, r); err != nil {
			t.Fatalf("%+v: %v", r, err)
		}
	}
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Transferring, VerifiedBytes: 300})), "invalid_bytes")
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Transferring, VerifiedBytes: 1001})), "invalid_bytes")
	wantCode(t, mustErr(e.svc.Report(ctx, sender.DeviceID, tr.ID, Report{Status: Completed, VerifiedBytes: 1000})), "receiver_only")
	wantCode(t, mustErr(e.svc.Report(ctx, sender.DeviceID, tr.ID, Report{Status: Transferring, VerifiedBytes: 400})), "receiver_only")
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Completed, VerifiedBytes: 999})), "not_verified")
	// Disconnect → reconnect → resume → complete.
	for _, r := range []Report{{Status: Disconnected, VerifiedBytes: 400}, {Status: Reconnecting, VerifiedBytes: 400}, {Status: Resuming, VerifiedBytes: 400}, {Status: Transferring, VerifiedBytes: 800}} {
		if _, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, r); err != nil {
			t.Fatalf("%+v: %v", r, err)
		}
	}
	done, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Completed, VerifiedBytes: 1000})
	if err != nil || done.Status != Completed || done.Route == nil || *done.Route != "direct" {
		t.Fatalf("complete: %+v %v", done, err)
	}
	if _, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Completed, VerifiedBytes: 1000}); err != nil {
		t.Fatalf("completing again is idempotent: %v", err)
	}
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Transferring, VerifiedBytes: 1000})), "invalid_transition")
	if got := e.note.updates(sender.DeviceID); len(got) < 8 || got[len(got)-1].Status != Completed {
		t.Fatalf("sender got %d updates", len(got))
	}
	if got := e.note.updates(rx.DeviceID); len(got) < 8 {
		t.Fatalf("receiver got %d updates", len(got))
	}
	if !contains(scrape(e.reg), "sa_transfers_completed_total 1") || !contains(scrape(e.reg), "sa_transfer_route_direct_total 1") ||
		!contains(scrape(e.reg), "sa_transfer_resumes_total 1") || !contains(scrape(e.reg), "sa_transfer_verified_bytes_total 1000") {
		t.Fatalf("metrics:\n%s", scrape(e.reg))
	}
}

func TestActionsAndCapability(t *testing.T) {
	e := newEnv(t, 1000)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	l, _ := e.svc.List(ctx, rx.DeviceID, s.ID)
	tr := byFile(l, 1000)
	if _, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Connecting}); err != nil {
		t.Fatal(err)
	}
	wantCode(t, mustErr(e.svc.Action(ctx, rx.DeviceID, tr.ID, "resume", l.Capability)), "invalid_transition")
	if p, err := e.svc.Action(ctx, sender.DeviceID, tr.ID, "pause", ""); err != nil || p.Status != Paused {
		t.Fatalf("pause: %+v %v", p, err)
	}
	// A paused transfer cannot be resumed through a report (that would skip the capability check).
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Transferring})), "use_resume")
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Resuming})), "use_resume")
	if _, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Paused}); err != nil {
		t.Fatalf("progress while paused: %v", err)
	}
	wantCode(t, mustErr(e.svc.Action(ctx, rx.DeviceID, tr.ID, "resume", "")), "capability_required")
	wantCode(t, mustErr(e.svc.Action(ctx, rx.DeviceID, tr.ID, "resume", "forged")), "capability_required")
	if r, err := e.svc.Action(ctx, rx.DeviceID, tr.ID, "resume", l.Capability); err != nil || r.Status != Resuming {
		t.Fatalf("resume: %+v %v", r, err)
	}
	if _, err := e.svc.Action(ctx, sender.DeviceID, tr.ID, "pause", ""); err != nil {
		t.Fatal(err)
	}
	if r, err := e.svc.Action(ctx, sender.DeviceID, tr.ID, "resume", ""); err != nil || r.Status != Resuming {
		t.Fatalf("sender resumes without a capability: %+v %v", r, err)
	}
	if c, err := e.svc.Action(ctx, rx.DeviceID, tr.ID, "cancel", ""); err != nil || c.Status != Cancelled {
		t.Fatalf("cancel: %+v %v", c, err)
	}
	if _, err := e.svc.Action(ctx, sender.DeviceID, tr.ID, "cancel", ""); err != nil {
		t.Fatalf("cancel again is idempotent: %v", err)
	}
	wantCode(t, mustErr(e.svc.Action(ctx, sender.DeviceID, tr.ID, "pause", "")), "invalid_transition")
}

func TestRemoveRevokesAndRejoinRestarts(t *testing.T) {
	e := newEnv(t, 1000)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	r := e.join(rx, s.Code)
	l1, _ := e.svc.List(ctx, rx.DeviceID, s.ID)
	if _, err := e.svc.Report(ctx, rx.DeviceID, byFile(l1, 1000).ID, Report{Status: Connecting}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.share.Decide(ctx, sender, r.Participant.ID, "remove"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.List(ctx, rx.DeviceID, s.ID); !errors.Is(err, errNotFound) {
		t.Fatalf("removed receiver list: %v", err)
	}
	wantCode(t, mustErr(e.svc.Action(ctx, rx.DeviceID, byFile(l1, 1000).ID, "resume", l1.Capability)), "not_found")
	sl, _ := e.svc.List(ctx, sender.DeviceID, s.ID)
	for _, tr := range sl.Transfers {
		if tr.Status != Cancelled {
			t.Fatalf("remove cancels transfers: %+v", tr)
		}
	}
	if sl.Peers[0].Status != sharing.PRemoved || sl.Peers[0].CapabilityHash != "" {
		t.Fatalf("removed peer keeps no capability: %+v", sl.Peers[0])
	}
	e.clk.Advance(time.Second)
	e.join(rx, s.Code) // rejoin with a valid code
	l2, err := e.svc.List(ctx, rx.DeviceID, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if l2.Capability == l1.Capability {
		t.Fatal("rejoin must issue a new capability")
	}
	for _, tr := range l2.Transfers {
		if tr.Status != Pending || tr.VerifiedBytes != 0 {
			t.Fatalf("rejoin restarts cancelled transfers: %+v", tr)
		}
	}
}

func TestClosedSessionAndRateLimit(t *testing.T) {
	e := newEnv(t, 3)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	l, _ := e.svc.List(ctx, rx.DeviceID, s.ID)
	tr := byFile(l, 10)
	for i := 0; i < 3; i++ {
		if _, err := e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Connecting}); err != nil {
			t.Fatal(err)
		}
	}
	wantCode(t, mustErr(e.svc.Report(ctx, rx.DeviceID, tr.ID, Report{Status: Connecting})), "rate_limited")
	if err := e.share.Close(ctx, sender, s.ID); err != nil {
		t.Fatal(err)
	}
	got, err := e.svc.Get(ctx, sender.DeviceID, tr.ID)
	if err != nil || got.Status != Cancelled {
		t.Fatalf("close cancels: %+v %v", got, err)
	}
	wantCode(t, mustErr(e.svc.Action(ctx, sender.DeviceID, tr.ID, "pause", "")), "invalid_transition")
}

func TestTransitionTable(t *testing.T) {
	cases := []struct {
		from, to string
		ok       bool
	}{
		{Pending, Connecting, true}, {Pending, Transferring, false}, {Pending, Completed, false},
		{Connecting, Transferring, true}, {Transferring, Paused, true}, {Paused, Resuming, true},
		{Transferring, Disconnected, true}, {Disconnected, Reconnecting, true}, {Reconnecting, Resuming, true},
		{Resuming, Transferring, true}, {Transferring, Completed, true}, {Disconnected, Completed, false},
		{Completed, Transferring, false}, {Cancelled, Pending, false}, {Transferring, Transferring, true},
	}
	for _, c := range cases {
		if got := CanMove(c.from, c.to); got != c.ok {
			t.Errorf("%s → %s: got %v", c.from, c.to, got)
		}
	}
	for _, s := range []string{Completed, Failed, Cancelled} {
		if !Terminal(s) {
			t.Errorf("%s is terminal", s)
		}
	}
}

func mustErr(_ Transfer, err error) error { return err }

func scrape(r *metrics.Registry) string {
	rec := httptest.NewRecorder()
	r.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	return rec.Body.String()
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

// TestTransitionsMatchSharedTable keeps the server table and the Web mirror in step through one JSON file.
func TestTransitionsMatchSharedTable(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/protocol/schemas/transfer-states.json")
	if err != nil {
		t.Fatal(err)
	}
	var shared struct {
		Next map[string][]string `json:"next"`
	}
	if err := json.Unmarshal(raw, &shared); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{Pending, Connecting, Transferring, Paused, Disconnected, Reconnecting, Resuming, Completed, Failed, Cancelled} {
		got, want := next[s], shared.Next[s]
		if len(got) == 0 && len(want) == 0 {
			continue
		}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%s: server %v, shared table %v", s, got, want)
		}
	}
	if len(shared.Next) != 10 {
		t.Errorf("shared table has %d states", len(shared.Next))
	}
}
