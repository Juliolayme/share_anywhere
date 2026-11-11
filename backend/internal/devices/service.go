// Package devices implements anonymous device identity: bootstrap with optional proof-of-work, signed
// access tokens, refresh-secret rotation with reuse detection, rename, reset, and purge
// (docs/SECURITY_MODEL.md §4–§5, docs/API.md §2.1).
package devices

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
)

// Lifetimes (docs/SECURITY_MODEL.md §4). A device added to an account lives 90 days without use; every
// other device (guest, or signed in but not added) 30 days.
const (
	AnonymousLifetime = 30 * 24 * time.Hour
	AccountLifetime   = 90 * 24 * time.Hour
	RevokedRetention  = 24 * time.Hour
	activeCacheTTL    = 30 * time.Second
	// RefreshReuseGrace: the immediately previous refresh secret is still accepted for this long after it was
	// used, once, when the newer secret was lost in transit (page closed or reloaded before the browser stored
	// the rotated cookie). The newer secret is retired, so the device never holds two live secrets. Any other
	// reuse revokes the device (docs/ADR/0011-refresh-reuse-grace.md).
	RefreshReuseGrace = 30 * time.Second
)

// Limits are the rate limits this package enforces (docs/SECURITY_MODEL.md §5).
type Limits struct {
	CreateHard *ratelimit.Limiter // per address: 429 beyond this
	CreateSoft *ratelimit.Limiter // per address: proof-of-work required beyond this
	Challenge  *ratelimit.Limiter // per address
	Refresh    *ratelimit.Limiter // per device
}

// DefaultLimits returns the production defaults.
func DefaultLimits(c clock.Clock) Limits { return ScaledLimits(c, 1) }

// ScaledLimits multiplies every limit by m (test stacks only; config allows m > 1 only with SA_ENV=test).
func ScaledLimits(c clock.Clock, m int) Limits {
	if m < 1 {
		m = 1
	}
	return Limits{
		CreateHard: ratelimit.New(ratelimit.Rule{Limit: 10 * m, Window: time.Hour}, c),
		CreateSoft: ratelimit.New(ratelimit.Rule{Limit: 3 * m, Window: time.Hour}, c),
		Challenge:  ratelimit.New(ratelimit.Rule{Limit: 30 * m, Window: time.Minute}, c),
		Refresh:    ratelimit.New(ratelimit.Rule{Limit: 60 * m, Window: time.Hour}, c),
	}
}

// RateLimitedError carries the wait before retrying.
type RateLimitedError struct{ Wait time.Duration }

func (e *RateLimitedError) Error() string { return fmt.Sprintf("rate limited for %s", e.Wait) }

// PoWRequiredError carries a fresh challenge the client must solve.
type PoWRequiredError struct {
	Token      string
	Difficulty int
}

func (e *PoWRequiredError) Error() string { return "proof of work required" }

// Refresh-secret transports (docs/ADR/0008-device-token-format.md).
const (
	TransportCookie = "cookie"
	TransportBody   = "body"
)

// ErrInvalidInput reports a request that failed validation.
var ErrInvalidInput = errors.New("invalid input")

// Session is the result of creating, refreshing, or resetting a device.
type Session struct {
	Device      Device
	AccessToken string
	ExpiresIn   int
	Secret      string
	Account     AccountState
}

// AccountState is a device's active account session as the account layer sees it (docs/SECURITY_MODEL.md
// §4): the zero value means no account session (guest).
type AccountState struct {
	AccountID string
	Added     bool
}

// Accounts is implemented by the account layer (internal/auth) and wired in cmd/server, so this package
// never imports it. AccountState returns the device's active, unexpired, unrevoked account session; touch
// marks it used (a refresh), which slides the lifetime of an added device's session.
type Accounts interface {
	AccountState(ctx context.Context, deviceID string, touch bool) (AccountState, error)
}

type noAccounts struct{}

func (noAccounts) AccountState(context.Context, string, bool) (AccountState, error) {
	return AccountState{}, nil
}

// Service implements the device identity operations.
type Service struct {
	store  Store
	tokens *Tokens
	pow    *PoW
	clock  clock.Clock
	limits Limits
	log    *slog.Logger

	accounts Accounts

	mu       sync.Mutex
	active   map[string]activeEntry
	acct     map[string]acctEntry
	onRevoke []func(deviceID string)
}

type acctEntry struct {
	state AccountState
	until time.Time
}

// SetAccounts installs the account layer. Without it every device is a guest and tokens carrying acct are
// refused.
func (s *Service) SetAccounts(a Accounts) { s.accounts = a }

// OnRevoke registers a callback run after a device is revoked (reset or refresh reuse), e.g. to close its
// WebSockets.
func (s *Service) OnRevoke(fn func(deviceID string)) { s.onRevoke = append(s.onRevoke, fn) }

func (s *Service) revoked(id string) {
	s.Forget(id)
	for _, fn := range s.onRevoke {
		fn(id)
	}
}

type activeEntry struct {
	active bool
	until  time.Time
}

// NewService wires the device identity service.
func NewService(store Store, tokens *Tokens, pow *PoW, c clock.Clock, limits Limits, log *slog.Logger) *Service {
	return &Service{store: store, tokens: tokens, pow: pow, clock: c, limits: limits, log: log, accounts: noAccounts{},
		active: map[string]activeEntry{}, acct: map[string]acctEntry{}}
}

// CreateInput is a validated bootstrap request.
type CreateInput struct {
	Platform string
	// Transport is "cookie" or "body"; it is stored and used for every later refresh and reset.
	Transport   string
	DisplayName string
	PoWToken    string
	PoWSolution string
}

func newSecret() (secret string, hash []byte) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	secret = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(secret))
	return secret, h[:]
}

func hashSecret(secret string) []byte {
	h := sha256.Sum256([]byte(secret))
	return h[:]
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ValidatePlatform and ValidateName clean user-supplied text and enforce length limits.
func ValidatePlatform(s string) (string, error) {
	s = CleanText(s)
	if n := len([]rune(s)); n < 1 || n > 60 {
		return "", ErrInvalidInput
	}
	return s, nil
}

// ValidateName cleans a display name and enforces 1–40 characters.
func ValidateName(s string) (string, error) {
	s = CleanText(s)
	if n := len([]rune(s)); n < 1 || n > 40 {
		return "", ErrInvalidInput
	}
	return s, nil
}

// Challenge returns a proof-of-work challenge for an address key.
func (s *Service) Challenge(addrKey string) (string, int, error) {
	if ok, wait := s.limits.Challenge.Allow(addrKey); !ok {
		return "", 0, &RateLimitedError{Wait: wait}
	}
	tok, diff := s.pow.Challenge(addrKey)
	return tok, diff, nil
}

// Create bootstraps an anonymous device for the caller at addrKey.
func (s *Service) Create(ctx context.Context, addrKey string, in CreateInput) (Session, error) {
	platform, err := ValidatePlatform(in.Platform)
	if err != nil {
		return Session{}, err
	}
	if in.Transport != TransportCookie && in.Transport != TransportBody {
		return Session{}, ErrInvalidInput
	}
	name := GenerateName(platform)
	if in.DisplayName != "" {
		if name, err = ValidateName(in.DisplayName); err != nil {
			return Session{}, err
		}
	}
	if ok, wait := s.limits.CreateHard.Allow(addrKey); !ok {
		return Session{}, &RateLimitedError{Wait: wait}
	}
	if ok, _ := s.limits.CreateSoft.Allow(addrKey); !ok {
		if in.PoWToken == "" || s.pow.Verify(addrKey, in.PoWToken, in.PoWSolution) != nil {
			tok, diff := s.pow.Challenge(addrKey)
			return Session{}, &PoWRequiredError{Token: tok, Difficulty: diff}
		}
	}
	return s.createDevice(ctx, platform, name, in.Transport)
}

func (s *Service) createDevice(ctx context.Context, platform, name, transport string) (Session, error) {
	now := s.clock.Now()
	secret, hash := newSecret()
	d := Device{
		ID: newUUID(), Kind: "anonymous", DisplayName: name, Platform: platform, Transport: transport,
		CreatedAt: now, LastSeenAt: now, ExpiresAt: now.Add(AnonymousLifetime),
	}
	if err := s.store.CreateDevice(ctx, d, hash); err != nil {
		return Session{}, fmt.Errorf("create device: %w", err)
	}
	return s.session(d, secret, AccountState{})
}

func (s *Service) session(d Device, secret string, acct AccountState) (Session, error) {
	tok, err := s.tokens.IssueWith(d.ID, d.Generation, acct)
	if err != nil {
		return Session{}, fmt.Errorf("issue token: %w", err)
	}
	return Session{Device: d, AccessToken: tok, ExpiresIn: int(AccessTokenTTL.Seconds()), Secret: secret, Account: acct}, nil
}

// Token issues a fresh access token for an active device with its current account state (acct, dl), without
// rotating the refresh secret. The account layer calls it after sign-in, sign-up, and Add this device.
func (s *Service) Token(ctx context.Context, deviceID string) (Session, error) {
	d, err := s.Get(ctx, deviceID)
	if err != nil {
		return Session{}, err
	}
	s.Forget(deviceID)
	acct, err := s.accounts.AccountState(ctx, deviceID, false)
	if err != nil {
		return Session{}, err
	}
	return s.session(d, "", acct)
}

// Replace revokes a device and bootstraps a brand-new anonymous identity with the same platform and refresh
// transport, so nothing links the two (sign-out, PRD §2). Unlike Reset it is not counted against the
// per-address creation limit: the caller held an account session, and sign-ins are rate limited.
func (s *Service) Replace(ctx context.Context, id string) (Session, error) {
	old, err := s.Get(ctx, id)
	if err != nil {
		return Session{}, err
	}
	if err := s.store.RevokeDevice(ctx, id, s.clock.Now()); err != nil {
		return Session{}, err
	}
	s.revoked(id)
	return s.createDevice(ctx, old.Platform, GenerateName(old.Platform), old.Transport)
}

// Refresh rotates a refresh secret and issues a new access token.
func (s *Service) Refresh(ctx context.Context, secret string) (Session, error) {
	if secret == "" || len(secret) > 128 {
		return Session{}, ErrSecretUnknown
	}
	old := hashSecret(secret)
	deviceID, err := s.store.SecretDevice(ctx, old)
	if err != nil {
		return Session{}, err
	}
	if ok, wait := s.limits.Refresh.Allow(deviceID); !ok {
		return Session{}, &RateLimitedError{Wait: wait}
	}
	next, hash := newSecret()
	d, err := s.store.RotateSecret(ctx, old, hash, s.clock.Now())
	if errors.Is(err, ErrSecretReused) {
		s.revoked(deviceID)
		s.log.Warn("refresh secret reuse detected; device revoked", "device", deviceID)
	}
	if err != nil {
		return Session{}, err
	}
	// acct and dl are re-derived from the device's active account session on every refresh, which also
	// slides an added device's session lifetime.
	s.Forget(d.ID)
	acct, err := s.accounts.AccountState(ctx, d.ID, true)
	if err != nil {
		return Session{}, err
	}
	return s.session(d, next, acct)
}

// Get returns an active device.
func (s *Service) Get(ctx context.Context, id string) (Device, error) {
	d, err := s.store.GetDevice(ctx, id)
	if err != nil {
		return Device{}, err
	}
	if !d.Active(s.clock.Now()) {
		return Device{}, ErrNotFound
	}
	return d, nil
}

// Rename changes the display name of an active device.
func (s *Service) Rename(ctx context.Context, id, name string) (Device, error) {
	clean, err := ValidateName(name)
	if err != nil {
		return Device{}, err
	}
	return s.store.RenameDevice(ctx, id, clean, s.clock.Now())
}

// Reset revokes the device and bootstraps a new anonymous identity with the same platform.
// It shares the per-address creation limit but needs no proof-of-work (the caller holds a valid token).
func (s *Service) Reset(ctx context.Context, id, addrKey string) (Session, error) {
	old, err := s.Get(ctx, id)
	if err != nil {
		return Session{}, err
	}
	if ok, wait := s.limits.CreateHard.Allow(addrKey); !ok {
		return Session{}, &RateLimitedError{Wait: wait}
	}
	if err := s.store.RevokeDevice(ctx, id, s.clock.Now()); err != nil {
		return Session{}, err
	}
	s.revoked(id)
	return s.createDevice(ctx, old.Platform, GenerateName(old.Platform), old.Transport)
}

// Verify implements access.Verifier: token signature and expiry, then the device must still be active.
func (s *Service) Verify(ctx context.Context, token string) (access.Identity, error) {
	id, err := s.tokens.Parse(token)
	if err != nil {
		return access.Identity{}, err
	}
	now := s.clock.Now()
	s.mu.Lock()
	e, ok := s.active[id.DeviceID]
	s.mu.Unlock()
	if !ok || now.After(e.until) {
		d, err := s.store.GetDevice(ctx, id.DeviceID)
		active := err == nil && d.Active(now)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return access.Identity{}, err
		}
		e = activeEntry{active: active, until: now.Add(activeCacheTTL)}
		s.mu.Lock()
		s.active[id.DeviceID] = e
		s.mu.Unlock()
	}
	if !e.active {
		return access.Identity{}, access.ErrTokenInvalid
	}
	if id.AccountID != "" {
		// A token minted before sign-out, revocation, or a password reset must stop granting account access
		// at once, not when it expires: compare its claims with the live account session.
		st, err := s.accountState(ctx, id.DeviceID, now)
		if err != nil {
			return access.Identity{}, err
		}
		if st.AccountID != id.AccountID || (id.DeviceAdded && !st.Added) {
			return access.Identity{}, access.ErrTokenInvalid
		}
	}
	return id, nil
}

// accountState is AccountState cached for activeCacheTTL; Forget clears it when the session changes.
func (s *Service) accountState(ctx context.Context, deviceID string, now time.Time) (AccountState, error) {
	s.mu.Lock()
	e, ok := s.acct[deviceID]
	s.mu.Unlock()
	if ok && !now.After(e.until) {
		return e.state, nil
	}
	st, err := s.accounts.AccountState(ctx, deviceID, false)
	if err != nil {
		return AccountState{}, err
	}
	s.mu.Lock()
	s.acct[deviceID] = acctEntry{state: st, until: now.Add(activeCacheTTL)}
	s.mu.Unlock()
	return st, nil
}

// Forget drops the cached activity and account state of a device; the account layer calls it whenever a
// device's account session starts, changes, or ends.
func (s *Service) Forget(id string) {
	s.mu.Lock()
	delete(s.active, id)
	delete(s.acct, id)
	s.mu.Unlock()
}

// Purge deletes anonymous devices unused for 30 days and revoked devices after a day.
func (s *Service) Purge(ctx context.Context) (int64, error) {
	now := s.clock.Now()
	return s.store.PurgeInactive(ctx, now.Add(-AnonymousLifetime), now.Add(-RevokedRetention))
}

// RunPurger purges every interval until ctx ends.
func (s *Service) RunPurger(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.Purge(ctx); err != nil {
				s.log.Error("device purge failed", "error", err.Error())
			} else if n > 0 {
				s.log.Info("purged inactive devices", "count", n)
			}
		}
	}
}
