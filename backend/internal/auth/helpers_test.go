package auth

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
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/migrations"
)

var ctx = context.Background()

var t0 = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

// cheapArgon2 keeps DB tests fast; TestArgon2Parameters covers the production values.
var cheapArgon2 = Argon2Params{MemoryKiB: 1024, Time: 1, Threads: 1, SaltLen: 16, KeyLen: 32}

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type env struct {
	t      *testing.T
	pool   *pgxpool.Pool
	clk    *clock.Fake
	dev    *devices.Service
	tokens *devices.Tokens
	svc    *Service
	mail   *MemoryMailer
	mux    *http.ServeMux
	nextIP int
}

// newEnv runs the migrations in a fresh schema of TEST_DATABASE_URL and wires devices + auth the way
// cmd/server does.
func newEnv(t *testing.T) *env {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	schema := "a_" + hex.EncodeToString(b)
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
	mail := NewMemoryMailer()
	svc := New(Config{Pool: pool, Clock: clk, Devices: dev, Hasher: NewHasher(cheapArgon2, 4), Mailer: mail,
		PublicURL: "https://app.example", Limits: ScaledLimits(clk, 1), Log: discard()})
	svc.background = func(fn func()) { fn() }
	dev.SetAccounts(svc)
	dev.OnRevoke(svc.DeviceRevoked)
	mux := http.NewServeMux()
	router := access.NewRouter(mux, dev)
	ips := clientip.New(nil)
	devHTTP := devices.NewHTTP(dev, ips, clk, true)
	devHTTP.Register(router)
	NewHTTP(svc, ips, devHTTP.WriteSession).Register(router)
	router.Finalize()
	return &env{t: t, pool: pool, clk: clk, dev: dev, tokens: tokens, svc: svc, mail: mail, mux: mux}
}

// device creates an anonymous device (Web cookie transport) from its own address.
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

// identUnchecked parses a token without the active-device and account checks (what a handler would see
// if a cache were stale).
func (e *env) identUnchecked(token string) access.Identity {
	id, _ := e.tokens.Parse(token)
	return id
}

type resp struct {
	code int
	body map[string]any
	raw  string
	hdr  http.Header
}

func (r resp) str(k string) string { s, _ := r.body[k].(string); return s }

// do sends a request from 192.0.2.1 unless ip is set with doFrom.
func (e *env) do(method, path, token string, body any) resp {
	return e.doFrom("192.0.2.1", method, path, token, body)
}

func (e *env) doFrom(ip, method, path, token string, body any) resp {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rd)
	req.RemoteAddr = ip + ":40000"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	out := resp{code: rec.Code, raw: rec.Body.String(), hdr: rec.Header()}
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

// signup creates an account on a new device and returns the device's account token.
func (e *env) signup(email string, add bool) (devices.Session, string) {
	e.t.Helper()
	d := e.device()
	r := e.doFrom(e.ip(), "POST", "/v1/auth/signup", d.AccessToken, map[string]any{"email": email, "password": testPassword, "add_device": add})
	e.want(r, 201, "")
	return d, r.str("access_token")
}

// signin signs a new device in and returns the device and its token.
func (e *env) signin(email string, add bool) (devices.Session, string) {
	e.t.Helper()
	d := e.device()
	r := e.doFrom(e.ip(), "POST", "/v1/auth/signin", d.AccessToken, map[string]any{"email": email, "password": testPassword, "add_device": add})
	e.want(r, 200, "")
	return d, r.str("access_token")
}

// ip is a distinct address for the latest device, so helpers do not share rate-limit buckets.
func (e *env) ip() string { return fmt.Sprintf("198.51.%d.%d", 100+e.nextIP/250, e.nextIP%250) }

func key32(b byte) string { return enc(bytes.Repeat([]byte{b}, 32)) }

func blob(n int, b byte) string { return enc(bytes.Repeat([]byte{b}, n)) }
