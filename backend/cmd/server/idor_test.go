package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/config"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/migrations"
)

// dbApp builds the whole server (every module, Cloud on with the memory store) on a fresh PostgreSQL schema.
func dbApp(t *testing.T) (*app, *pgxpool.Pool) {
	t.Helper()
	return dbAppWith(t, clock.Real{}, nil)
}

// dbAppWith is dbApp with a clock and extra environment (production limits unless the caller scales them).
func dbAppWith(t *testing.T, clk clock.Clock, env map[string]string) (*app, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	schema := "idor_" + hex.EncodeToString(b)
	admin, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	pcfg, _ := pgxpool.ParseConfig(url)
	pcfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
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
	vars := map[string]string{
		"SA_ENV": "test", "SA_ALLOWED_ORIGINS": "http://localhost:5173",
		"SA_CLOUD_ENABLED": "true", "SA_CLOUD_STORE": "memory",
	}
	for k, v := range env {
		vars[k] = v
	}
	cfg, err := config.LoadFrom(func(k string) (string, bool) {
		v, ok := vars[k]
		return v, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	a, err := newApp(cfg, pool, devices.NewPGStore(pool), clk, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.hub.Close)
	return a, pool
}

type actor struct {
	name, ip, token, device string
}

type idorEnv struct {
	t *testing.T
	a *app
}

func (e *idorEnv) actor(name string, n int) actor {
	e.t.Helper()
	ip := fmt.Sprintf("203.0.113.%d", n)
	s, err := e.a.devices.Create(context.Background(), ip, devices.CreateInput{Platform: "Web", Transport: devices.TransportCookie})
	if err != nil {
		e.t.Fatal(err)
	}
	return actor{name: name, ip: ip, token: s.AccessToken, device: s.Device.ID}
}

func (e *idorEnv) do(who actor, method, path string, body any) (int, []byte) {
	e.t.Helper()
	var r io.Reader = strings.NewReader("{}")
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, r)
	req.RemoteAddr = who.ip + ":40000"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+who.token)
	rec := httptest.NewRecorder()
	e.a.handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// signedIn signs `who` up as a new account and adds the device, so routes behind the account gate (Cloud) are
// reached and their ownership checks are what refuses.
func (e *idorEnv) signedIn(who actor, email string) actor {
	e.t.Helper()
	var r struct {
		AccessToken string `json:"access_token"`
	}
	e.ok(who, "POST", "/v1/auth/signup", map[string]any{"email": email, "password": "Granite-Lantern-Orbit-7", "add_device": false}, &r)
	who.token = r.AccessToken
	e.ok(who, "POST", "/v1/devices/current/add", map[string]any{"copy_history": false}, &r)
	who.token = r.AccessToken
	return who
}

func (e *idorEnv) ok(who actor, method, path string, body, out any) {
	e.t.Helper()
	code, raw := e.do(who, method, path, body)
	if code/100 != 2 {
		e.t.Fatalf("%s %s %s: %d %s", who.name, method, path, code, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			e.t.Fatal(err)
		}
	}
}

type sessionOut struct {
	ID    string `json:"id"`
	Code  string `json:"code"`
	Files []struct {
		ID string `json:"id"`
	} `json:"files"`
}

func (e *idorEnv) session(owner actor) sessionOut {
	e.t.Helper()
	var s sessionOut
	e.ok(owner, "POST", "/v1/sessions", map[string]any{"files": []map[string]any{{"name": "a.bin", "size": 1000}, {"name": "b.bin", "size": 2000}}}, &s)
	return s
}

func (e *idorEnv) join(who actor, s sessionOut) string {
	e.t.Helper()
	var p struct {
		SessionID string `json:"session_id"`
		Ticket    string `json:"join_ticket"`
	}
	e.ok(who, "POST", "/v1/sessions/resolve-code", map[string]any{"code": s.Code}, &p)
	var j struct {
		Participant struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"participant"`
	}
	e.ok(who, "POST", "/v1/sessions/"+s.ID+"/join", map[string]any{"ticket": p.Ticket}, &j)
	if j.Participant.Status != "JOINED" {
		e.t.Fatalf("%s join: %+v", who.name, j)
	}
	return j.Participant.ID
}

type transferOut struct {
	ID            string `json:"id"`
	ParticipantID string `json:"participant_id"`
	Status        string `json:"status"`
}

func (e *idorEnv) transfers(who actor, sessionID string) []transferOut {
	e.t.Helper()
	var l struct {
		Transfers []transferOut `json:"transfers"`
	}
	e.ok(who, "GET", "/v1/sessions/"+sessionID+"/transfers", nil, &l)
	return l.Transfers
}

// TestIDORSweep (docs/SECURITY_MODEL.md §6, Phase 9): across every module, a device can reach only resources of
// sessions it belongs to, and only in its role. A stranger (a device with a session of its own, in none of
// Alice's) and a receiver acting on the sender's or another receiver's resources get an error status for every
// participant-level route with a resource id, Cloud's device-level object routes and TURN; nothing changes.
func TestIDORSweep(t *testing.T) {
	a, pool := dbApp(t)
	e := &idorEnv{t: t, a: a}
	alice, bob, carol, mallory := e.actor("alice", 1), e.actor("bob", 2), e.actor("carol", 3), e.actor("mallory", 4)
	// Sam is a signed-in stranger with an added device: past the account gate, only ownership can refuse him.
	sam := e.signedIn(e.actor("sam", 5), "sam-idor@example.com")
	sa := e.session(alice)
	_ = e.session(mallory) // Mallory is a sender elsewhere: a valid participant token, just not for Alice's session.
	bobPid, carolPid := e.join(bob, sa), e.join(carol, sa)
	all := e.transfers(alice, sa.ID)
	var bobTx, carolTx string
	for _, x := range all {
		switch x.ParticipantID {
		case bobPid:
			bobTx = x.ID
		case carolPid:
			carolTx = x.ID
		}
	}
	if bobTx == "" || carolTx == "" {
		t.Fatalf("transfers: %+v", all)
	}
	// A READY cloud object of Alice's first file (inserted directly: distributing needs a signed-in, added sender).
	obj := "7a1c0000-0000-4000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO cloud_objects (id, session_id, file_id, owner_user_id, owner_device_id,
		status, size, part_size, part_count, created_at, expires_at, sealed_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, '00000000-0000-4000-8000-0000000000aa', $4::uuid, 'READY', 1000, 4194304, 1, now(), now() + interval '1 hour', now())`,
		obj, sa.ID, sa.Files[0].ID, alice.device); err != nil {
		t.Fatal(err)
	}

	type call struct {
		method, path string
		body         any
	}
	report := map[string]any{"status": "CONNECTING", "verified_bytes": 0}
	// Routes on Alice's session that only its members may use.
	memberOnly := []call{
		{"GET", "/v1/sessions/" + sa.ID, nil},
		{"GET", "/v1/sessions/" + sa.ID + "/files", nil},
		{"GET", "/v1/sessions/" + sa.ID + "/transfers", nil},
		{"GET", "/v1/sessions/" + sa.ID + "/cloud", nil},
		{"POST", "/v1/turn/credentials", map[string]any{"session_id": sa.ID}},
		{"GET", "/v1/cloud/objects/" + obj, nil},
		{"GET", "/v1/cloud/objects/" + obj + "/parts/0", nil},
		{"POST", "/v1/cloud/objects/" + obj + "/received", nil},
	}
	// Routes only the sender may use.
	senderOnly := []call{
		{"PATCH", "/v1/sessions/" + sa.ID, map[string]any{"accepting_receivers": false}},
		{"POST", "/v1/sessions/" + sa.ID + "/close", nil},
		{"POST", "/v1/sessions/" + sa.ID + "/renew", nil},
		{"POST", "/v1/participants/" + carolPid + "/approve", nil},
		{"POST", "/v1/participants/" + carolPid + "/reject", nil},
		{"DELETE", "/v1/participants/" + carolPid, nil},
		{"POST", "/v1/participants/" + carolPid + "/block", nil},
		{"POST", "/v1/files/" + sa.Files[0].ID + "/distribute", nil},
		{"PUT", "/v1/cloud/objects/" + obj + "/parts/0", nil},
		{"POST", "/v1/cloud/objects/" + obj + "/seal", nil},
	}
	// Routes on Carol's own participant and transfer: neither Bob nor a stranger may use them.
	carolOnly := []call{
		{"POST", "/v1/participants/" + carolPid + "/leave", nil},
		{"GET", "/v1/transfers/" + carolTx, nil},
		{"POST", "/v1/transfers/" + carolTx + "/report", report},
		{"POST", "/v1/transfers/" + carolTx + "/pause", nil},
		{"POST", "/v1/transfers/" + carolTx + "/resume", nil},
		{"POST", "/v1/transfers/" + carolTx + "/cancel", nil},
	}
	// A refusal must be an authorization answer (403 forbidden or 404 not found), never a validation or state
	// error that would hide whether the caller could have acted.
	gates := map[string]bool{"cloud_requires_account": true, "account_required": true, "device_not_added": true, "cloud_consent_required": true}
	denied := func(who actor, calls []call, pastGates bool) {
		for _, c := range calls {
			code, raw := e.do(who, c.method, c.path, c.body)
			var body struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(raw, &body)
			if code != 403 && code != 404 {
				t.Errorf("%s %s %s: got %d %s, want 403 or 404", who.name, c.method, c.path, code, raw)
			} else if pastGates && gates[body.Error] {
				t.Errorf("%s %s %s: refused by the account gate (%s), not by ownership", who.name, c.method, c.path, body.Error)
			}
		}
	}
	denied(mallory, memberOnly, false)
	denied(mallory, senderOnly, false)
	denied(mallory, carolOnly, false)
	denied(bob, senderOnly, false)
	denied(bob, carolOnly, false)
	// Bob's own transfer stays out of Mallory's reach too.
	denied(mallory, []call{{"GET", "/v1/transfers/" + bobTx, nil}, {"POST", "/v1/transfers/" + bobTx + "/cancel", nil}}, false)
	// The signed-in stranger: every route, and Cloud's sender routes refuse him by ownership.
	denied(sam, memberOnly, true)
	denied(sam, senderOnly, true)
	denied(sam, carolOnly, true)

	// Nothing changed: the session is open and accepting, Carol is still joined, no transfer moved.
	var view struct {
		Status     string `json:"status"`
		JoinWindow struct {
			State string `json:"state"`
		} `json:"join_window"`
		Code         string `json:"code"`
		Participants []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"participants"`
	}
	e.ok(alice, "GET", "/v1/sessions/"+sa.ID, nil, &view)
	if view.Status == "CLOSED" || view.JoinWindow.State != "OPEN" || view.Code != sa.Code {
		t.Errorf("session changed: %+v", view)
	}
	for _, p := range view.Participants {
		if p.ID == carolPid && p.Status != "JOINED" {
			t.Errorf("carol is %s", p.Status)
		}
	}
	for _, x := range e.transfers(alice, sa.ID) {
		if x.Status != "PENDING" && x.Status != "WAITING" {
			for _, y := range all {
				if y.ID == x.ID && y.Status != x.Status {
					t.Errorf("transfer %s moved %s -> %s", x.ID, y.Status, x.Status)
				}
			}
		}
	}
	// And the members can use their routes (the sweep is not passing because everything is refused).
	e.ok(bob, "GET", "/v1/sessions/"+sa.ID, nil, nil)
	e.ok(bob, "GET", "/v1/transfers/"+bobTx, nil, nil)
	e.ok(carol, "GET", "/v1/transfers/"+carolTx, nil, nil)
	e.ok(bob, "GET", "/v1/cloud/objects/"+obj, nil, nil)
	// The sender's routes work for the sender (after the checks above, since they change the session).
	e.ok(alice, "PATCH", "/v1/sessions/"+sa.ID, map[string]any{"accepting_receivers": false}, nil)
	e.ok(alice, "DELETE", "/v1/participants/"+carolPid, nil, nil)
	e.ok(carol, "GET", "/v1/sessions/"+sa.ID, nil, nil) // a removed receiver still sees the outcome

}
