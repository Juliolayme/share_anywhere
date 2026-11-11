// Package auth implements accounts layered on device identity (Phase 5A): sign-up, sign-in, sign-out,
// password reset, account sessions with the acct and dl claims, the account-wide Devices list, account keys
// (wrapped ADK blobs, recovery copy, rotation, pairing), and encrypted cloud history (docs/API.md §2.4,
// docs/SECURITY_MODEL.md §4–§7, docs/ARCHITECTURE.md §3.3, §8). File sharing never depends on it.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
)

// Lifetimes (docs/SECURITY_MODEL.md §4, §6).
const (
	// AddedSessionIdle ends an added device's account session after 90 days without use (sliding).
	AddedSessionIdle = devices.AccountLifetime
	// NotAddedSessionMax ends a not-added device's account session 24 h after sign-in (not sliding).
	NotAddedSessionMax = 24 * time.Hour
	// ResetTokenTTL is the lifetime of a password-reset link.
	ResetTokenTTL = 30 * time.Minute
	// PairingTTL is the lifetime of a device pairing code.
	PairingTTL = 10 * time.Minute
)

// Size limits for opaque blobs (contract: blobs ≤ 4 KB, public keys exactly 32 bytes, history ciphertext
// ≤ 64 KB).
const (
	maxBlob       = 4 << 10
	minWrapBlob   = 32 + 12 + 16 + 32 // eph_pub || nonce || ADK ciphertext || tag
	minChainBlob  = 12 + 32 + 16      // nonce || ADK ciphertext || tag
	keyLen        = 32
	nonceLen      = 12
	maxCiphertext = 64 << 10
)

// Identity is the device-identity service this package builds on (implemented by *devices.Service).
type Identity interface {
	Get(ctx context.Context, id string) (devices.Device, error)
	// Token issues an access token whose acct and dl reflect the device's current account session.
	Token(ctx context.Context, deviceID string) (devices.Session, error)
	// Replace revokes a device and returns a brand-new anonymous identity (sign-out).
	Replace(ctx context.Context, deviceID string) (devices.Session, error)
	// Forget drops cached account state for a device whose account session changed.
	Forget(deviceID string)
}

// Limits are the account rate limits (docs/SECURITY_MODEL.md §5).
type Limits struct {
	SigninIPEmail  *ratelimit.Limiter // per IP + email: every attempt
	SigninIP       *ratelimit.Limiter // per IP: every attempt
	SigninDevice   *ratelimit.Limiter // per device: every attempt
	SigninEmail    *ratelimit.Limiter // per email: failed attempts only, from any address
	SignupIP       *ratelimit.Limiter // per IP
	SignupDevice   *ratelimit.Limiter // per device
	ResetEmail     *ratelimit.Limiter // per email
	ResetIP        *ratelimit.Limiter // per IP
	PasswordChange *ratelimit.Limiter // per account: failed current-password checks
	PairingCreate  *ratelimit.Limiter // per device
	PairingLookup  *ratelimit.Limiter // per device
	PairingIP      *ratelimit.Limiter // per IP: pairing create and lookup
	HistoryWrite   *ratelimit.Limiter // per device: entry creation and deletion
}

// ScaledLimits returns the defaults multiplied by m (test stacks only; config allows m > 1 only with
// SA_ENV=test).
func ScaledLimits(c clock.Clock, m int) Limits {
	if m < 1 {
		m = 1
	}
	r := func(n int, w time.Duration) *ratelimit.Limiter {
		return ratelimit.New(ratelimit.Rule{Limit: n * m, Window: w}, c)
	}
	return Limits{
		SigninIPEmail:  r(5, 15*time.Minute),
		SigninIP:       r(30, time.Hour),
		SigninDevice:   r(10, 15*time.Minute),
		SigninEmail:    r(20, time.Hour),
		SignupIP:       r(5, time.Hour),
		SignupDevice:   r(3, time.Hour),
		ResetEmail:     r(3, time.Hour),
		ResetIP:        r(10, time.Hour),
		PasswordChange: r(5, 15*time.Minute),
		PairingCreate:  r(10, time.Hour),
		PairingLookup:  r(30, 10*time.Minute),
		PairingIP:      r(60, 10*time.Minute),
		HistoryWrite:   r(600, time.Minute),
	}
}

// Config wires the service.
type Config struct {
	Pool      *pgxpool.Pool
	Clock     clock.Clock
	Devices   Identity
	Hasher    *Hasher
	Mailer    Mailer
	PublicURL string
	Limits    Limits
	Log       *slog.Logger
}

// Service implements the account operations.
type Service struct {
	cfg Config
	// background runs work that must not delay or shape the response (reset mail); tests run it inline.
	background func(func())
}

// New returns the account service.
func New(cfg Config) *Service {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Mailer == nil {
		cfg.Mailer = ConsoleMailer{Log: cfg.Log}
	}
	return &Service{cfg: cfg, background: func(fn func()) { go fn() }}
}

// Error is a documented API error (docs/API.md §3).
type Error struct {
	Status int
	Code   string
	Msg    string
	Wait   time.Duration
	Extra  map[string]any
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s", e.Status, e.Code) }

func errf(status int, code, msg string) *Error { return &Error{Status: status, Code: code, Msg: msg} }

// Documented errors.
var (
	ErrInvalid      = errf(http.StatusBadRequest, "invalid_request", "Check the request.")
	ErrInvalidEmail = errf(http.StatusBadRequest, "invalid_email", "Enter a valid email address.")
	ErrWeak         = errf(http.StatusBadRequest, "weak_password", "Use 10 to 128 characters that are hard to guess.")
	ErrResetInvalid = errf(http.StatusBadRequest, "reset_token_invalid", "This reset link is invalid or has expired. Request a new one.")
	ErrInvalidCreds = errf(http.StatusUnauthorized, "invalid_credentials", "Email or password is incorrect.")
	// ErrWrongPassword is 403, not 401, so clients do not mistake it for an expired access token.
	ErrWrongPassword     = errf(http.StatusForbidden, "invalid_credentials", "The current password is incorrect.")
	ErrTokenStale        = errf(http.StatusUnauthorized, "device_token_invalid", "The device access token is not valid.")
	ErrAccountRequired   = errf(http.StatusForbidden, "account_required", "Sign in to use this feature.")
	ErrDeviceNotAdded    = errf(http.StatusForbidden, "device_not_added", "Add this device to your account to use this feature.")
	ErrNotFound          = errf(http.StatusNotFound, "not_found", "Not found.")
	ErrEmailTaken        = errf(http.StatusConflict, "email_taken", "An account with this email already exists. Sign in instead.")
	ErrAlreadySignedIn   = errf(http.StatusConflict, "already_signed_in", "This device is already signed in. Sign out first.")
	ErrUseSignout        = errf(http.StatusConflict, "use_signout", "Sign out to remove this device.")
	ErrKeysExist         = errf(http.StatusConflict, "keys_exist", "This account already has a data key.")
	ErrKeyVersion        = errf(http.StatusConflict, "key_version_conflict", "The account key changed. Reload the keys and try again.")
	ErrPairingConflict   = errf(http.StatusConflict, "pairing_conflict", "Another pairing for this device started at the same time. Try again.")
	errDevicesChangedMsg = "The account's devices changed. Reload the keys and try again."
)

func rateLimited(wait time.Duration) *Error {
	return &Error{Status: http.StatusTooManyRequests, Code: "rate_limited", Msg: "Too many attempts. Try again later.", Wait: wait}
}

// allow spends one token from every limiter (key pairs); the first refusal wins.
func allow(pairs ...any) error {
	for i := 0; i+1 < len(pairs); i += 2 {
		l := pairs[i].(*ratelimit.Limiter)
		if ok, wait := l.Allow(pairs[i+1].(string)); !ok {
			return rateLimited(wait)
		}
	}
	return nil
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// newToken returns a 256-bit random token (base64url) and its SHA-256.
func newToken(n int) (string, []byte) {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	tok := base64.RawURLEncoding.EncodeToString(b)
	return tok, hashToken(tok)
}

func hashToken(tok string) []byte {
	h := sha256.Sum256([]byte(tok))
	return h[:]
}

func isUniqueViolation(err error, constraint string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && (constraint == "" || pg.ConstraintName == constraint)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// b64 decodes a base64url (unpadded) field.
func b64(s string) ([]byte, bool) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	return b, err == nil
}

func enc(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
