package clipboard

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/auth"
	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ws"
	"github.com/juliolayme/share_anywhere/backend/migrations"
)

var ctx = context.Background()

var t0 = time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type env struct {
	t      *testing.T
	pool   *pgxpool.Pool
	clk    *clock.Fake
	dev    *devices.Service
	tokens *devices.Tokens
	auth   *auth.Service
	svc    *Service
	hub    *ws.Hub
	mux    *http.ServeMux
	nextIP int
}

// newEnv runs the migrations in a fresh schema of TEST_DATABASE_URL and wires devices, auth, the WebSocket
// hub, and clipboard the way cmd/server does. mult scales the clipboard rate limits (1 = production values).
func newEnv(t *testing.T, mult int) *env {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	schema := "c_" + hex.EncodeToString(b)
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
	clk := clock.NewFake(t0)
	seed := make([]byte, ed25519.SeedSize)
	tokens, err := devices.NewTokens(map[string]ed25519.PrivateKey{"k1": ed25519.NewKeyFromSeed(seed)}, "k1", clk)
	if err != nil {
		t.Fatal(err)
	}
	dev := devices.NewService(devices.NewPGStore(pool), tokens, devices.NewPoW([]byte("0123456789abcdef0123456789abcdef"), 8, clk),
		clk, devices.ScaledLimits(clk, 100), discard())
	ips := clientip.New([]netip.Prefix{})
	hub := ws.NewHub(ws.Config{AllowedOrigins: []string{"https://app.example"}, Clock: clk, IPs: ips, Log: discard()})
	dev.OnRevoke(hub.DisconnectDevice)
	authSvc := auth.New(auth.Config{Pool: pool, Clock: clk, Devices: dev, Hasher: auth.NewHasher(cheapArgon2, 4),
		Mailer: auth.NewMemoryMailer(), PublicURL: "https://app.example", Limits: auth.ScaledLimits(clk, 100), Log: discard()})
	dev.SetAccounts(authSvc)
	dev.OnRevoke(authSvc.DeviceRevoked)
	svc := New(Config{Pool: pool, Clock: clk, Accounts: authSvc, Notify: hub, Limits: ScaledLimits(clk, mult), Log: discard()})
	authSvc.OnSweep("clipboard", svc.RunSweep)
	hub.OnPresence(svc.Presence)
	mux := http.NewServeMux()
	router := access.NewRouter(mux, dev)
	devHTTP := devices.NewHTTP(dev, ips, clk, true)
	devHTTP.Register(router)
	auth.NewHTTP(authSvc, ips, devHTTP).Register(router)
	hub.Register(router)
	NewHTTP(svc).Register(router)
	router.Finalize()
	return &env{t: t, pool: pool, clk: clk, dev: dev, tokens: tokens, auth: authSvc, svc: svc, hub: hub, mux: mux}
}

var cheapArgon2 = auth.Argon2Params{MemoryKiB: 1024, Time: 1, Threads: 1, SaltLen: 16, KeyLen: 32}

// device creates an anonymous device (Web cookie transport).
func (e *env) device() devices.Session {
	e.t.Helper()
	e.nextIP++
	s, err := e.dev.Create(ctx, fmt.Sprintf("dev-%d", e.nextIP), devices.CreateInput{Platform: "Web · Test", Transport: devices.TransportCookie})
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *env) ident(token string) access.Identity {
	e.t.Helper()
	id, err := e.dev.Verify(ctx, token)
	if err != nil {
		e.t.Fatalf("verify: %v", err)
	}
	return id
}

// identUnchecked parses a token without the active-device and account checks (what a handler would see if a
// cache were stale).
func (e *env) identUnchecked(token string) access.Identity {
	id, _ := e.tokens.Parse(token)
	return id
}

type resp struct {
	code int
	body map[string]any
	raw  string
}

func (r resp) str(k string) string { s, _ := r.body[k].(string); return s }

func (e *env) ip() string { return fmt.Sprintf("198.51.%d.%d", 100+e.nextIP/250, e.nextIP%250) }

func (e *env) do(method, path, token string, body any) resp {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		if raw, ok := body.([]byte); ok {
			rd = bytes.NewReader(raw)
		} else {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
	}
	req := httptest.NewRequest(method, path, rd)
	req.RemoteAddr = e.ip() + ":40000"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	out := resp{code: rec.Code, raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.body)
	return out
}

func (e *env) want(r resp, code int, errCode string) {
	e.t.Helper()
	if r.code != code || (errCode != "" && r.str("error") != errCode) {
		e.t.Fatalf("got %d %s, want %d %s", r.code, r.raw, code, errCode)
	}
}

const testPassword = "correct horse battery"

// signup creates an account on a new device (added) and gives the account key version 1, the state of an
// account after key setup (key setup itself is covered in internal/auth).
func (e *env) signup(email string) (devices.Session, string) {
	e.t.Helper()
	d := e.device()
	r := e.do("POST", "/v1/auth/signup", d.AccessToken, map[string]any{"email": email, "password": testPassword, "add_device": true})
	e.want(r, 201, "")
	if _, err := e.pool.Exec(ctx, `UPDATE account_keys SET key_version = 1 WHERE user_id = $1::uuid`, r.body["account"].(map[string]any)["id"]); err != nil {
		e.t.Fatal(err)
	}
	return d, r.str("access_token")
}

// signin signs a new device in (added or not) and returns it with its token.
func (e *env) signin(email string, add bool) (devices.Session, string) {
	e.t.Helper()
	d := e.device()
	r := e.do("POST", "/v1/auth/signin", d.AccessToken, map[string]any{"email": email, "password": testPassword, "add_device": add})
	e.want(r, 200, "")
	return d, r.str("access_token")
}

func newID() string { return uuid.NewString() }

func blob(n int, b byte) string { return enc(bytes.Repeat([]byte{b}, n)) }

// eventBody is a well-formed event of payload size n (ciphertext n+16 bytes).
func eventBody(eventID string, kv, n int) map[string]any {
	return map[string]any{"event_id": eventID, "key_version": kv, "nonce": blob(12, 1), "ciphertext": blob(n+16, 2), "payload_size": n}
}

func input(eventID string, kv int) EventInput {
	return EventInput{EventID: eventID, KeyVersion: kv, Nonce: blob(12, 1), Ciphertext: blob(48, 2), PayloadSize: 32}
}

func (e *env) count(q string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}
