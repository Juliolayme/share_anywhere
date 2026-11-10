// Package config loads and validates backend configuration from the environment.
package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

// Environment names.
const (
	EnvDevelopment = "development"
	EnvTest        = "test"
	EnvProduction  = "production"
)

// Config is the validated runtime configuration.
type Config struct {
	Env             string
	HTTPAddr        string
	DatabaseURL     string
	LogLevel        string
	ShutdownTimeout time.Duration
	AllowedOrigins  []string

	// TokenKeys maps a key ID to its Ed25519 signing key; TokenActiveKID signs new tokens.
	TokenKeys      map[string]ed25519.PrivateKey
	TokenActiveKID string
	// ServerSecret keys HMACs (proof-of-work challenges, log IP hashes, later code HMACs).
	ServerSecret []byte
	// TrustedProxies are the only peers whose X-Forwarded-For is believed.
	TrustedProxies []netip.Prefix
	// CookieSecure sets the Secure attribute on the refresh cookie. Only non-production may disable it.
	CookieSecure bool
	// PoWDifficulty is the leading-zero bits required by the anonymous-device proof-of-work.
	PoWDifficulty int
	// TURNSecret is coturn's static-auth-secret; TURNURIs are the ICE server URIs given to clients.
	TURNSecret []byte
	TURNURIs   []string
	// PublicURL is the Web origin used in join links and QR codes (defaults to the first allowed origin).
	PublicURL string
	// MetricsAddr serves Prometheus metrics on a separate internal listener; empty disables it.
	MetricsAddr string
	// CodeGuessAlarmPerMin trips protected mode (docs/SECURITY_MODEL.md §3.1).
	CodeGuessAlarmPerMin int
	// RateLimitMultiplier scales rate limits for test stacks (SA_ENV=test only; 1 elsewhere).
	RateLimitMultiplier int
	// MigrateOnStart applies pending migrations at startup.
	MigrateOnStart bool
	// Generated lists settings filled with ephemeral development values (never in production).
	Generated []string
}

// Lookup reads one variable; os.LookupEnv in production, a map in tests.
type Lookup func(key string) (string, bool)

// Load reads configuration from the process environment.
func Load() (Config, error) { return LoadFrom(os.LookupEnv) }

// LoadFrom reads configuration using lookup and validates it.
func LoadFrom(lookup Lookup) (Config, error) {
	get := func(key, def string) string {
		if v, ok := lookup(key); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		return def
	}

	cfg := Config{
		Env:         get("SA_ENV", EnvDevelopment),
		HTTPAddr:    get("SA_HTTP_ADDR", ":8080"),
		DatabaseURL: get("DATABASE_URL", ""),
		LogLevel:    get("SA_LOG_LEVEL", "info"),
	}

	var errs []error

	timeout, err := time.ParseDuration(get("SA_SHUTDOWN_TIMEOUT", "10s"))
	if err != nil || timeout <= 0 {
		errs = append(errs, fmt.Errorf("SA_SHUTDOWN_TIMEOUT must be a positive duration such as 10s"))
	}
	cfg.ShutdownTimeout = timeout

	for _, o := range strings.Split(get("SA_ALLOWED_ORIGINS", ""), ",") {
		if o = strings.TrimSpace(o); o != "" {
			if !strings.HasPrefix(o, "https://") && !strings.HasPrefix(o, "http://") {
				errs = append(errs, fmt.Errorf("SA_ALLOWED_ORIGINS entry %q must start with http:// or https://", o))
			}
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, strings.TrimRight(o, "/"))
		}
	}

	switch cfg.Env {
	case EnvDevelopment, EnvTest, EnvProduction:
	default:
		errs = append(errs, fmt.Errorf("SA_ENV must be one of development, test, production; got %q", cfg.Env))
	}

	switch cfg.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, fmt.Errorf("SA_LOG_LEVEL must be one of debug, info, warn, error; got %q", cfg.LogLevel))
	}

	// Token signing keys: "kid:base64-seed,kid2:base64-seed" (32-byte Ed25519 seeds).
	cfg.TokenKeys = map[string]ed25519.PrivateKey{}
	for _, entry := range strings.Split(get("SA_TOKEN_KEYS", ""), ",") {
		if entry = strings.TrimSpace(entry); entry == "" {
			continue
		}
		kid, seed, ok := strings.Cut(entry, ":")
		raw, err := base64.StdEncoding.DecodeString(seed)
		if !ok || kid == "" || err != nil || len(raw) != ed25519.SeedSize {
			errs = append(errs, fmt.Errorf("SA_TOKEN_KEYS entries must be kid:base64(32-byte seed)"))
			continue
		}
		cfg.TokenKeys[kid] = ed25519.NewKeyFromSeed(raw)
	}
	cfg.TokenActiveKID = get("SA_TOKEN_ACTIVE_KID", "")

	if v := get("SA_SERVER_SECRET", ""); v != "" {
		raw, err := base64.StdEncoding.DecodeString(v)
		if err != nil || len(raw) < 32 {
			errs = append(errs, errors.New("SA_SERVER_SECRET must be base64 of at least 32 bytes"))
		}
		cfg.ServerSecret = raw
	}

	for _, p := range strings.Split(get("SA_TRUSTED_PROXIES", ""), ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(p)
		if err != nil {
			errs = append(errs, fmt.Errorf("SA_TRUSTED_PROXIES entry %q is not a CIDR prefix", p))
			continue
		}
		cfg.TrustedProxies = append(cfg.TrustedProxies, prefix)
	}

	cfg.CookieSecure = get("SA_COOKIE_SECURE", "true") != "false"
	cfg.MigrateOnStart = get("SA_MIGRATE_ON_START", "false") == "true"
	diff, err := strconv.Atoi(get("SA_POW_DIFFICULTY", "16"))
	if err != nil || diff < 8 || diff > 28 {
		errs = append(errs, errors.New("SA_POW_DIFFICULTY must be an integer between 8 and 28"))
	}
	cfg.PoWDifficulty = diff
	// SA_RATE_LIMIT_MULTIPLIER raises every limit for automated test stacks, where all browsers share one
	// address. It is test configuration, not a way to switch limits off: only SA_ENV=test accepts it.
	mult, err := strconv.Atoi(get("SA_RATE_LIMIT_MULTIPLIER", "1"))
	switch {
	case err != nil || mult < 1 || mult > 1000:
		errs = append(errs, errors.New("SA_RATE_LIMIT_MULTIPLIER must be an integer between 1 and 1000"))
	case mult != 1 && cfg.Env != EnvTest:
		errs = append(errs, errors.New("SA_RATE_LIMIT_MULTIPLIER is only allowed with SA_ENV=test"))
	}
	cfg.RateLimitMultiplier = mult

	if v := get("SA_TURN_SECRET", ""); v != "" {
		cfg.TURNSecret = []byte(v)
	}
	for _, u := range strings.Split(get("SA_TURN_URIS", "turn:localhost:3478?transport=udp,turn:localhost:3478?transport=tcp"), ",") {
		if u = strings.TrimSpace(u); u == "" {
			continue
		}
		if !strings.HasPrefix(u, "turn:") && !strings.HasPrefix(u, "turns:") && !strings.HasPrefix(u, "stun:") {
			errs = append(errs, fmt.Errorf("SA_TURN_URIS entry %q must use the turn, turns or stun scheme", u))
			continue
		}
		cfg.TURNURIs = append(cfg.TURNURIs, u)
	}
	cfg.PublicURL = strings.TrimRight(get("SA_PUBLIC_URL", ""), "/")
	if cfg.PublicURL == "" && len(cfg.AllowedOrigins) > 0 {
		cfg.PublicURL = cfg.AllowedOrigins[0]
	}
	if cfg.PublicURL != "" && !strings.HasPrefix(cfg.PublicURL, "https://") && !strings.HasPrefix(cfg.PublicURL, "http://") {
		errs = append(errs, errors.New("SA_PUBLIC_URL must start with http:// or https://"))
	}
	alarm, err := strconv.Atoi(get("SA_CODE_GUESS_ALARM_PER_MIN", "300"))
	if err != nil || alarm < 10 || alarm > 100000 {
		errs = append(errs, errors.New("SA_CODE_GUESS_ALARM_PER_MIN must be an integer between 10 and 100000"))
	}
	cfg.CodeGuessAlarmPerMin = alarm
	cfg.MetricsAddr = get("SA_METRICS_ADDR", "")

	if cfg.Env == EnvProduction {
		if len(cfg.TokenKeys) == 0 || cfg.TokenActiveKID == "" {
			errs = append(errs, errors.New("SA_TOKEN_KEYS and SA_TOKEN_ACTIVE_KID are required in production"))
		}
		if len(cfg.ServerSecret) == 0 {
			errs = append(errs, errors.New("SA_SERVER_SECRET is required in production"))
		}
		if !cfg.CookieSecure {
			errs = append(errs, errors.New("SA_COOKIE_SECURE cannot be false in production"))
		}
		if len(cfg.TURNSecret) < 16 {
			errs = append(errs, errors.New("SA_TURN_SECRET (at least 16 characters, shared with coturn) is required in production"))
		}
		if !strings.HasPrefix(cfg.PublicURL, "https://") {
			errs = append(errs, errors.New("SA_PUBLIC_URL (or the first SA_ALLOWED_ORIGINS entry) must be https in production"))
		}
	} else {
		// Development and test get ephemeral secrets so the stack starts with no setup; tokens do not
		// survive a restart, which is acceptable outside production.
		if len(cfg.TokenKeys) == 0 {
			_, key, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				errs = append(errs, fmt.Errorf("generate dev token key: %w", err))
			}
			cfg.TokenKeys["dev"] = key
			cfg.TokenActiveKID = "dev"
			cfg.Generated = append(cfg.Generated, "SA_TOKEN_KEYS")
		}
		if len(cfg.TURNSecret) == 0 {
			cfg.TURNSecret = []byte("dev-turn-secret-change-me")
			cfg.Generated = append(cfg.Generated, "SA_TURN_SECRET")
		}
		if len(cfg.ServerSecret) == 0 {
			cfg.ServerSecret = make([]byte, 32)
			if _, err := rand.Read(cfg.ServerSecret); err != nil {
				errs = append(errs, fmt.Errorf("generate dev server secret: %w", err))
			}
			cfg.Generated = append(cfg.Generated, "SA_SERVER_SECRET")
		}
	}
	if cfg.TokenActiveKID != "" {
		if _, ok := cfg.TokenKeys[cfg.TokenActiveKID]; !ok {
			errs = append(errs, fmt.Errorf("SA_TOKEN_ACTIVE_KID %q is not in SA_TOKEN_KEYS", cfg.TokenActiveKID))
		}
	}

	if cfg.Env == EnvProduction {
		if cfg.DatabaseURL == "" {
			errs = append(errs, errors.New("DATABASE_URL is required in production"))
		}
		for _, o := range cfg.AllowedOrigins {
			if strings.HasPrefix(o, "http://") {
				errs = append(errs, fmt.Errorf("SA_ALLOWED_ORIGINS entry %q must use https in production", o))
			}
		}
	}

	return cfg, errors.Join(errs...)
}
