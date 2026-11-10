// Package access enforces the per-route access levels declared in shared/protocol/openapi.yaml
// (`x-sa-access`) and documented in docs/API.md §1.
package access

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
)

// Level is an access level.
type Level string

// Access levels (docs/API.md §1).
const (
	Public        Level = "public"
	Device        Level = "device"
	Participant   Level = "participant"
	Account       Level = "account"
	AccountDevice Level = "account+device"
)

// Identity is what a verified device access token proves.
type Identity struct {
	DeviceID    string
	Generation  int
	AccountID   string
	DeviceAdded bool
}

// Token verification errors.
var (
	ErrTokenInvalid = errors.New("device token invalid")
	ErrTokenExpired = errors.New("device token expired")
)

// Verifier checks a bearer access token and that the device is still active.
type Verifier interface {
	Verify(ctx context.Context, token string) (Identity, error)
}

type ctxKey struct{}

// WithIdentity stores an identity in ctx (used by handlers and tests).
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// FromContext returns the verified identity, if any.
func FromContext(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(Identity)
	return id, ok
}

// Route describes one registered operation.
type Route struct {
	Method  string
	Pattern string
	Level   Level
}

// Router registers handlers with their access level and keeps a registry for tests.
type Router struct {
	mux      *http.ServeMux
	verifier Verifier
	routes   []Route
	methods  map[string][]string
	order    []string
}

// fallbackMethods get a 405 on known paths that do not implement them.
var fallbackMethods = []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions}

// Finalize registers 405 responses (with Allow) for unimplemented methods on every known path, so they do
// not fall through to 404. It runs once, after all modules registered their routes; registering per method
// avoids conflicts between literal paths and wildcard paths that a method-less pattern would cause.
func (r *Router) Finalize() {
	for _, pattern := range r.order {
		allowed := map[string]bool{}
		for _, m := range r.methods[pattern] {
			allowed[m] = true
		}
		allow := append([]string(nil), r.methods[pattern]...)
		sort.Strings(allow)
		header := strings.Join(allow, ", ")
		for _, m := range fallbackMethods {
			if allowed[m] {
				continue
			}
			r.mux.HandleFunc(m+" "+pattern, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Allow", header)
				httpx.Error(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			})
		}
	}
}

// NewRouter returns a router enforcing levels with v.
func NewRouter(mux *http.ServeMux, v Verifier) *Router {
	return &Router{mux: mux, verifier: v, methods: map[string][]string{}}
}

// Handle registers h for "METHOD pattern" at level.
func (r *Router) Handle(method, pattern string, level Level, h http.HandlerFunc) {
	r.routes = append(r.routes, Route{Method: method, Pattern: pattern, Level: level})
	if _, seen := r.methods[pattern]; !seen {
		r.order = append(r.order, pattern)
	}
	r.methods[pattern] = append(r.methods[pattern], method)
	if method == http.MethodGet {
		r.methods[pattern] = append(r.methods[pattern], http.MethodHead)
	}
	r.mux.Handle(method+" "+pattern, r.wrap(level, h))
}

// Routes returns every registered operation (HEAD aliases excluded).
func (r *Router) Routes() []Route { return append([]Route(nil), r.routes...) }

func (r *Router) wrap(level Level, h http.HandlerFunc) http.Handler {
	if level == Public {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		token, ok := bearer(req)
		if !ok {
			httpx.Error(w, http.StatusUnauthorized, "device_token_invalid", "A device access token is required.")
			return
		}
		id, err := r.verifier.Verify(req.Context(), token)
		switch {
		case errors.Is(err, ErrTokenExpired):
			httpx.Error(w, http.StatusUnauthorized, "device_token_expired", "The device access token has expired.")
			return
		case err != nil:
			httpx.Error(w, http.StatusUnauthorized, "device_token_invalid", "The device access token is not valid.")
			return
		}
		switch level {
		case Account:
			if id.AccountID == "" {
				httpx.Error(w, http.StatusForbidden, "account_required", "Sign in to use this feature.")
				return
			}
		case AccountDevice:
			if id.AccountID == "" {
				httpx.Error(w, http.StatusForbidden, "account_required", "Sign in to use this feature.")
				return
			}
			if !id.DeviceAdded {
				httpx.Error(w, http.StatusForbidden, "device_not_added", "Add this device to your account to use this feature.")
				return
			}
		}
		// Participant checks need the session and happen in the handler, after the device check above.
		h(w, req.WithContext(WithIdentity(req.Context(), id)))
	})
}

func bearer(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const p = "Bearer "
	if len(h) <= len(p) || !strings.EqualFold(h[:len(p)], p) {
		return "", false
	}
	return strings.TrimSpace(h[len(p):]), true
}
