package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/config"
)

func testApp(t *testing.T) *app {
	t.Helper()
	cfg, err := config.LoadFrom(func(k string) (string, bool) {
		v, ok := map[string]string{"SA_ENV": "test", "SA_ALLOWED_ORIGINS": "http://localhost:5173"}[k]
		return v, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	a, err := newApp(cfg, nil, devices.NewMemStore(), clock.Real{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

type spec struct {
	Paths map[string]map[string]yaml.Node `yaml:"paths"`
}

func loadSpec(t *testing.T) map[string]string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "protocol", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var s spec
	if err := yaml.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for path, ops := range s.Paths {
		for method, node := range ops {
			switch method {
			case "get", "post", "put", "patch", "delete":
			default:
				continue
			}
			var op struct {
				Access string `yaml:"x-sa-access"`
			}
			if err := node.Decode(&op); err != nil {
				t.Fatal(err)
			}
			if op.Access == "" {
				t.Errorf("%s %s has no x-sa-access", strings.ToUpper(method), path)
			}
			out[strings.ToUpper(method)+" "+path] = op.Access
		}
	}
	return out
}

// TestRouteTableMatchesOpenAPI: every registered route exists in openapi.yaml with the same access
// level, and every operation in openapi.yaml is registered (CLAUDE.md §7, docs/API.md §1).
func TestRouteTableMatchesOpenAPI(t *testing.T) {
	want := loadSpec(t)
	got := map[string]string{}
	for _, r := range testApp(t).router.Routes() {
		got[r.Method+" "+r.Pattern] = string(r.Level)
	}
	var keys []string
	for k := range want {
		keys = append(keys, k)
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		if want[k] != got[k] {
			t.Errorf("%s: openapi.yaml says %q, server registers %q", k, want[k], got[k])
		}
	}
}

// TestNonPublicRoutesRejectAnonymousCalls checks enforcement, not just declaration: every route
// whose level is not public answers 401 without a token and with a forged one.
func TestNonPublicRoutesRejectAnonymousCalls(t *testing.T) {
	a := testApp(t)
	for _, r := range a.router.Routes() {
		if r.Level == access.Public {
			continue
		}
		for _, auth := range []string{"", "Bearer forged.token.value"} {
			req := httptest.NewRequest(r.Method, r.Pattern, strings.NewReader("{}"))
			if auth != "" {
				req.Header.Set("Authorization", auth)
			}
			rec := httptest.NewRecorder()
			a.handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s %s auth=%q: got %d, want 401", r.Method, r.Pattern, auth, rec.Code)
			}
		}
	}
}

// fakeAccounts stands in for the account layer (internal/auth needs PostgreSQL) so the route test can mint
// signed-in tokens whose claims match the "live" account session.
type fakeAccounts map[string]devices.AccountState

func (f fakeAccounts) AccountState(_ context.Context, id string, _ bool) (devices.AccountState, error) {
	return f[id], nil
}

// TestAccountLevelsFromOpenAPI is table-driven over the x-sa-access levels in openapi.yaml: every
// `account` route answers 403 account_required to a guest token, and every `account+device` route answers
// 403 account_required to a guest and 403 device_not_added to a signed-in device that is not added
// (docs/API.md §1, CLAUDE.md §7). The checks run in the access middleware, before any handler.
func TestAccountLevelsFromOpenAPI(t *testing.T) {
	a := testApp(t)
	mk := func(addr string) devices.Session {
		s, err := a.devices.Create(context.Background(), addr, devices.CreateInput{Platform: "Web", Transport: devices.TransportCookie})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	guest, notAdded := mk("198.51.100.1"), mk("198.51.100.2")
	acct := devices.AccountState{AccountID: "00000000-0000-4000-8000-000000000001"}
	a.devices.SetAccounts(fakeAccounts{notAdded.Device.ID: acct})
	notAddedTok, err := a.tokens.IssueWith(notAdded.Device.ID, notAdded.Device.Generation, acct)
	if err != nil {
		t.Fatal(err)
	}
	// A forged dl=true claim for a device whose session is not added is refused outright.
	forged, _ := a.tokens.IssueWith(notAdded.Device.ID, notAdded.Device.Generation, devices.AccountState{AccountID: acct.AccountID, Added: true})

	call := func(method, path, token string) (int, string) {
		req := httptest.NewRequest(method, path, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		a.handler.ServeHTTP(rec, req)
		var body struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body.Error
	}
	counts := map[string]int{}
	for key, level := range loadSpec(t) {
		method, path, _ := strings.Cut(key, " ")
		switch level {
		case "account":
			if code, e := call(method, path, guest.AccessToken); code != 403 || e != "account_required" {
				t.Errorf("%s guest: got %d %s, want 403 account_required", key, code, e)
			}
		case "account+device":
			if code, e := call(method, path, guest.AccessToken); code != 403 || e != "account_required" {
				t.Errorf("%s guest: got %d %s, want 403 account_required", key, code, e)
			}
			if code, e := call(method, path, notAddedTok); code != 403 || e != "device_not_added" {
				t.Errorf("%s not added: got %d %s, want 403 device_not_added", key, code, e)
			}
			if code, e := call(method, path, forged); code != 401 || e != "device_token_invalid" {
				t.Errorf("%s forged dl: got %d %s, want 401 device_token_invalid", key, code, e)
			}
		default:
			continue
		}
		counts[level]++
	}
	// Phase 5A declares 7 account and 16 account+device operations; the test must not pass vacuously.
	if counts["account"] < 7 || counts["account+device"] < 16 {
		t.Fatalf("too few account routes in openapi.yaml: %v", counts)
	}
}
