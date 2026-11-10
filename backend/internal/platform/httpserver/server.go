// Package httpserver wires the HTTP router, middleware, and health endpoints.
package httpserver

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"
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
}

// NewHandler returns the root handler with health endpoints and common middleware.
func NewHandler(opts Options) http.Handler {
	if opts.ReadyTimeout <= 0 {
		opts.ReadyTimeout = 2 * time.Second
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": opts.Version})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
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
	for _, path := range []string{"/healthz", "/readyz"} {
		mux.HandleFunc(path, methodNotAllowed("GET, HEAD"))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found", "message": "No such endpoint."})
	})
	return recoverer(opts.Logger, securityHeaders(requestLogger(opts.Logger, mux)))
}

// methodNotAllowed answers 405 for a known path called with the wrong method.
func methodNotAllowed(allow string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", allow)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed", "message": "Method not allowed."})
	}
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

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

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

func recoverer(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				log.Error("panic in handler", "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal", "message": "Something went wrong."})
			}
		}()
		next.ServeHTTP(w, r)
	})
}
