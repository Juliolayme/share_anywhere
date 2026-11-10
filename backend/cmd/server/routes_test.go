package main

import (
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
	a, err := newApp(cfg, devices.NewMemStore(), clock.Real{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

type spec struct {
	Paths map[string]map[string]struct {
		Access string `yaml:"x-sa-access"`
	} `yaml:"paths"`
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
		for method, op := range ops {
			switch method {
			case "get", "post", "put", "patch", "delete":
			default:
				continue
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
