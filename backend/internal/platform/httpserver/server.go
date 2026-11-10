// Package httpserver wires the HTTP router, middleware, and health endpoints.
package httpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
)

// Check reports whether a dependency is ready. It must honour ctx cancellation.
type Check struct {
	Name string
	Fn   func(ctx context.Context) error
}

// Options configures the handler.
type Options struct {
	Logger  *slog.Logger
	Version string
	Checks  []Check
	// ReadyTimeout bounds each readiness check. Defaults to 2s.
	ReadyTimeout time.Duration
	// Verifier checks device access tokens for non-public routes. Nil rejects every token.
	Verifier access.Verifier
	// Modules register their routes, each with an access level (docs/API.md §1).
	Modules []func(*access.Router)
}

type denyAll struct{}

func (denyAll) Verify(context.Context, string) (access.Identity, error) {
	return access.Identity{}, access.ErrTokenInvalid
}

// NewHandler returns the root handler with health endpoints and common middleware.
func NewHandler(opts Options) http.Handler {
	h, _ := New(opts)
	return h
}

// New returns the root handler and the router, whose route table tests compare with openapi.yaml.
func New(opts Options) (http.Handler, *access.Router) {
	if opts.ReadyTimeout <= 0 {
		opts.ReadyTimeout = 2 * time.Second
	}
	if opts.Verifier == nil {
		opts.Verifier = denyAll{}
	}
	mux := http.NewServeMux()
	router := access.NewRouter(mux, opts.Verifier)
	router.Handle(http.MethodGet, "/healthz", access.Public, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": opts.Version})
	})
	router.Handle(http.MethodGet, "/readyz", access.Public, func(w http.ResponseWriter, r *http.Request) {
		results := map[string]string{}
		status := http.StatusOK
		for _, c := range opts.Checks {
			ctx, cancel := context.WithTimeout(r.Context(), opts.ReadyTimeout)
			err := c.Fn(ctx)
			cancel()
			if err != nil {
				results[c.Name] = "unavailable"
				status = http.StatusServiceUnavailable
				opts.Logger.Warn("readiness check failed", "check", c.Name, "error", err.Error())
			} else {
				results[c.Name] = "ok"
			}
		}
		body := map[string]any{"status": "ok", "checks": results}
		if status != http.StatusOK {
			body["status"] = "unavailable"
		}
		writeJSON(w, status, body)
	})
	for _, register := range opts.Modules {
		register(router)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "No such endpoint."})
	})
	return recoverer(opts.Logger, securityHeaders(requestLogger(opts.Logger, mux))), router
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cache-Control", "no-store")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the status code. Unwrap lets http.ResponseController reach
// Flush, Hijack (WebSocket upgrades), and deadline methods on the underlying writer.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.wroteHeader = true
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// requestLogger logs method, path (never the query string, which may carry tokens), status, and duration.
func requestLogger(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		level := slog.LevelInfo
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			level = slog.LevelDebug
		}
		log.Log(r.Context(), level, "http request",
			"method", r.Method, "path", r.URL.Path, "status_code", rec.status,
			"duration_ms", time.Since(start).Milliseconds())
	})
}

// recoverer turns a handler panic into a logged 500. http.ErrAbortHandler is re-raised so the
// server aborts the response as intended, and no body is written if the handler already started one.
func recoverer(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			log.Error("panic in handler", "path", r.URL.Path, "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
			if !rec.wroteHeader {
				writeJSON(rec, http.StatusInternalServerError, map[string]string{"error": "internal", "message": "Something went wrong."})
			}
		}()
		next.ServeHTTP(rec, r)
	})
}
