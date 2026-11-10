package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/logging"
)

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestHealthz(t *testing.T) {
	h := NewHandler(Options{Logger: discard(), Version: "test"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["status"] != "ok" || body["version"] != "test" {
		t.Fatalf("body %s err %v", rec.Body.String(), err)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("missing security headers: %v", rec.Header())
	}
}

func TestHealthzRejectsOtherMethods(t *testing.T) {
	h := NewHandler(Options{Logger: discard()})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", rec.Code)
	}
	if rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("missing Allow header: %v", rec.Header())
	}
}

func TestReadyz(t *testing.T) {
	ok := Check{Name: "database", Fn: func(context.Context) error { return nil }}
	bad := Check{Name: "database", Fn: func(context.Context) error { return errors.New("down") }}

	rec := httptest.NewRecorder()
	NewHandler(Options{Logger: discard(), Checks: []Check{ok}}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"database":"ok"`) {
		t.Fatalf("ready: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	NewHandler(Options{Logger: discard(), Checks: []Check{bad}}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"database":"unavailable"`) {
		t.Fatalf("not ready: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "down") {
		t.Fatalf("readiness body must not leak error details: %s", rec.Body.String())
	}
}

func TestUnknownRouteIsJSON404(t *testing.T) {
	rec := httptest.NewRecorder()
	NewHandler(Options{Logger: discard()}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"error":"not_found"`) {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestRequestLogOmitsQueryString(t *testing.T) {
	var buf bytes.Buffer
	h := NewHandler(Options{Logger: logging.New(&buf, "debug")})
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/nope?ticket=secret-value", nil))
	if strings.Contains(buf.String(), "secret-value") {
		t.Fatalf("query string leaked into logs: %s", buf.String())
	}
	if !strings.Contains(buf.String(), `"path":"/nope"`) {
		t.Fatalf("expected path in logs: %s", buf.String())
	}
}

func TestRecoverer(t *testing.T) {
	h := recoverer(discard(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "boom") {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}
