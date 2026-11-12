// Package turncreds issues time-limited coturn credentials (use-auth-secret / TURN REST API) to the sender
// and JOINED receivers of an ACTIVE session (docs/ARCHITECTURE.md §6, docs/SECURITY_MODEL.md §5, §6).
package turncreds

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" // #nosec G505 -- coturn's use-auth-secret mandates HMAC-SHA1
	"encoding/base64"
	"net/http"
	"strconv"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// TTLs (docs/SECURITY_MODEL.md §6).
const (
	GuestTTL   = 30 * time.Minute
	AccountTTL = 60 * time.Minute
)

// Authorizer checks the caller is the sender or a JOINED receiver of an ACTIVE session.
type Authorizer interface {
	TurnParticipant(ctx context.Context, deviceID, sessionID string) (participantID string, err error)
}

// Config wires the issuer.
type Config struct {
	Secret     []byte
	URIs       []string
	Clock      clock.Clock
	Auth       Authorizer
	GuestLimit *ratelimit.Limiter
	AcctLimit  *ratelimit.Limiter
	IPLimit    *ratelimit.Limiter // optional, keyed by address key
	IPKey      func(*http.Request) string
	Log        interface{ Error(string, ...any) }
	// Relay byte cap per session (optional; both Scope and Usage are needed). GuestCap applies when the sender is
	// a guest, AccountCap when signed in; zero falls back to the defaults.
	Scope      Scoper
	Usage      Usage
	GuestCap   int64
	AccountCap int64
	// Counters (optional): credentials issued, refused at the relay cap, and cap checks skipped because coturn's
	// usage could not be read (the cap fails open: coturn's own quotas still apply).
	Issued, CapRefused, UsageUnavailable interface{ Inc() }
}

// Issuer issues credentials.
type Issuer struct{ cfg Config }

// New returns an issuer.
func New(cfg Config) *Issuer { return &Issuer{cfg: cfg} }

// Credentials is the response body; it maps directly onto RTCIceServer.
type Credentials struct {
	Username   string    `json:"username"`
	Credential string    `json:"credential"`
	URIs       []string  `json:"uris"`
	TTL        int       `json:"ttl"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// Sign computes the coturn REST credential: username "<unix expiry>:<participant>", password
// base64(HMAC-SHA1(secret, username)).
func Sign(secret []byte, participantID string, expires time.Time) (username, credential string) {
	username = strconv.FormatInt(expires.Unix(), 10) + ":" + participantID
	m := hmac.New(sha1.New, secret)
	m.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(m.Sum(nil))
}

// Register adds POST /v1/turn/credentials (participant level: checked against the session in the handler).
func (i *Issuer) Register(r *access.Router) {
	r.Handle(http.MethodPost, "/v1/turn/credentials", access.Participant, i.issue)
}

func (i *Issuer) issue(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SessionID string `json:"session_id"`
	}
	if err := httpx.Decode(r, &in, 1<<10, false); err != nil {
		httpx.BadRequest(w, "Expected session_id.")
		return
	}
	id, _ := access.FromContext(r.Context())
	limit, ttl := i.cfg.GuestLimit, GuestTTL
	if id.AccountID != "" {
		limit, ttl = i.cfg.AcctLimit, AccountTTL
	}
	pid, err := i.cfg.Auth.TurnParticipant(r.Context(), id.DeviceID, in.SessionID)
	if err != nil {
		sharing.WriteError(w, err, i.cfg.Log)
		return
	}
	if ok, wait := limit.Allow(id.DeviceID); !ok {
		httpx.RateLimited(w, "rate_limited", wait)
		return
	}
	if i.cfg.IPLimit != nil && i.cfg.IPKey != nil {
		if ok, wait := i.cfg.IPLimit.Allow(i.cfg.IPKey(r)); !ok {
			httpx.RateLimited(w, "rate_limited", wait)
			return
		}
	}
	if refused := i.overCap(r.Context(), in.SessionID); refused {
		if i.cfg.CapRefused != nil {
			i.cfg.CapRefused.Inc()
		}
		httpx.Error(w, http.StatusForbidden, "relay_cap_reached", "This session used its relay allowance; only direct connections remain.")
		return
	}
	exp := i.cfg.Clock.Now().Add(ttl)
	user, cred := Sign(i.cfg.Secret, pid, exp)
	if i.cfg.Issued != nil {
		i.cfg.Issued.Inc()
	}
	httpx.JSON(w, http.StatusOK, Credentials{Username: user, Credential: cred, URIs: i.cfg.URIs, TTL: int(ttl.Seconds()), ExpiresAt: exp.UTC()})
}

// overCap reports whether the session's relay traffic has reached its cap. When usage cannot be read the check is
// skipped (logged and counted): the cap is an abuse guard on top of coturn's quotas, not a gate for every relay.
func (i *Issuer) overCap(ctx context.Context, sessionID string) bool {
	if i.cfg.Scope == nil || i.cfg.Usage == nil {
		return false
	}
	ids, account, err := i.cfg.Scope.RelayScope(ctx, sessionID)
	if err != nil {
		return false
	}
	used, err := i.cfg.Usage.RelayBytes(ctx, ids)
	if err != nil {
		if i.cfg.UsageUnavailable != nil {
			i.cfg.UsageUnavailable.Inc()
		}
		if i.cfg.Log != nil {
			i.cfg.Log.Error("turn usage unavailable", "err", err)
		}
		return false
	}
	limit := i.cfg.GuestCap
	if limit <= 0 {
		limit = DefaultGuestRelayCap
	}
	if account {
		limit = i.cfg.AccountCap
		if limit <= 0 {
			limit = DefaultAccountRelayCap
		}
	}
	return used >= limit
}
