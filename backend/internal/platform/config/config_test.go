package config

import (
	"strings"
	"testing"
	"time"
)

func lookupFrom(m map[string]string) Lookup {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestDefaults(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Env != EnvDevelopment || cfg.HTTPAddr != ":8080" || cfg.LogLevel != "info" || cfg.ShutdownTimeout != 10*time.Second {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestValidationErrors(t *testing.T) {
	cases := map[string]struct {
		env  map[string]string
		want string
	}{
		"bad env":          {map[string]string{"SA_ENV": "staging"}, "SA_ENV must be one of"},
		"bad level":        {map[string]string{"SA_LOG_LEVEL": "loud"}, "SA_LOG_LEVEL must be one of"},
		"bad timeout":      {map[string]string{"SA_SHUTDOWN_TIMEOUT": "soon"}, "SA_SHUTDOWN_TIMEOUT"},
		"negative timeout": {map[string]string{"SA_SHUTDOWN_TIMEOUT": "-1s"}, "SA_SHUTDOWN_TIMEOUT"},
		"bad origin":       {map[string]string{"SA_ALLOWED_ORIGINS": "example.com"}, "must start with http"},
		"prod needs db":    {map[string]string{"SA_ENV": "production"}, "DATABASE_URL is required"},
		"prod needs https": {map[string]string{"SA_ENV": "production", "DATABASE_URL": "postgres://x", "SA_ALLOWED_ORIGINS": "http://a.example"}, "must use https"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := LoadFrom(lookupFrom(tc.env))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %v", tc.want, err)
			}
		})
	}
}

// seed32 is base64 of 32 zero bytes, a valid (test-only) Ed25519 seed.
const seed32 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

func TestDevGeneratesEphemeralSecrets(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(nil))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.TokenKeys) != 1 || cfg.TokenActiveKID != "dev" || len(cfg.ServerSecret) != 32 || len(cfg.Generated) != 3 {
		t.Fatalf("unexpected generated config: kid=%q secret=%d generated=%v", cfg.TokenActiveKID, len(cfg.ServerSecret), cfg.Generated)
	}
	if !cfg.CookieSecure || cfg.PoWDifficulty != 16 || cfg.MigrateOnStart {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestExplicitKeysAndProxies(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(map[string]string{
		"SA_TOKEN_KEYS": "k1:" + seed32 + ",k2:" + seed32, "SA_TOKEN_ACTIVE_KID": "k2",
		"SA_SERVER_SECRET": seed32, "SA_TRUSTED_PROXIES": "172.16.0.0/12, 10.0.0.0/8", "SA_COOKIE_SECURE": "false",
		"SA_TURN_SECRET": "explicit-turn-secret",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.TokenKeys) != 2 || cfg.TokenActiveKID != "k2" || len(cfg.TrustedProxies) != 2 || cfg.CookieSecure || len(cfg.Generated) != 0 {
		t.Fatalf("unexpected: %+v", cfg)
	}
}

func TestOriginsAreTrimmed(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(map[string]string{"SA_ALLOWED_ORIGINS": " https://a.example/ , http://localhost:5173 "}))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[0] != "https://a.example" || cfg.AllowedOrigins[1] != "http://localhost:5173" {
		t.Fatalf("unexpected origins %#v", cfg.AllowedOrigins)
	}
}

func TestRateLimitMultiplierOnlyInTest(t *testing.T) {
	load := func(env map[string]string) (Config, error) {
		return LoadFrom(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	}
	if c, err := load(map[string]string{"SA_ENV": "test", "SA_RATE_LIMIT_MULTIPLIER": "100"}); err != nil || c.RateLimitMultiplier != 100 {
		t.Fatalf("test env: %v %v", c.RateLimitMultiplier, err)
	}
	if c, err := load(map[string]string{"SA_ENV": "development"}); err != nil || c.RateLimitMultiplier != 1 {
		t.Fatalf("default: %v %v", c.RateLimitMultiplier, err)
	}
	for _, env := range []map[string]string{
		{"SA_ENV": "development", "SA_RATE_LIMIT_MULTIPLIER": "10"},
		{"SA_ENV": "test", "SA_RATE_LIMIT_MULTIPLIER": "0"},
		{"SA_ENV": "test", "SA_RATE_LIMIT_MULTIPLIER": "x"},
	} {
		if _, err := load(env); err == nil {
			t.Errorf("%v should fail", env)
		}
	}
}

func TestSharingSettings(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(map[string]string{"SA_ALLOWED_ORIGINS": "https://app.example/", "SA_TURN_URIS": "turn:t.example:3478, turns:t.example:443?transport=tcp"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicURL != "https://app.example" || len(cfg.TURNURIs) != 2 || cfg.CodeGuessAlarmPerMin != 300 {
		t.Fatalf("defaults: %q %v %d", cfg.PublicURL, cfg.TURNURIs, cfg.CodeGuessAlarmPerMin)
	}
	for _, env := range []map[string]string{
		{"SA_TURN_URIS": "http://nope"},
		{"SA_PUBLIC_URL": "ftp://x"},
		{"SA_CODE_GUESS_ALARM_PER_MIN": "1"},
		{"SA_ENV": "production", "DATABASE_URL": "postgres://x", "SA_ALLOWED_ORIGINS": "https://a.example", "SA_TOKEN_KEYS": "k:" + seed32, "SA_TOKEN_ACTIVE_KID": "k", "SA_SERVER_SECRET": seed32},
	} {
		if _, err := LoadFrom(lookupFrom(env)); err == nil {
			t.Errorf("%v should fail", env)
		}
	}
}

func TestMailSettings(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(nil))
	if err != nil || cfg.MailSink != "console" || cfg.MailFrom == "" {
		t.Fatalf("defaults: %+v %v", cfg.MailSink, err)
	}
	cfg, err = LoadFrom(lookupFrom(map[string]string{"SA_MAIL_SINK": "smtp", "SA_SMTP_ADDR": "mailpit:1025"}))
	if err != nil || cfg.SMTPAddr != "mailpit:1025" {
		t.Fatalf("smtp: %+v %v", cfg.SMTPAddr, err)
	}
	if _, err := LoadFrom(lookupFrom(map[string]string{"SA_ENV": "test", "SA_MAIL_SINK": "memory"})); err != nil {
		t.Fatalf("memory in test: %v", err)
	}
	for name, env := range map[string]map[string]string{
		"smtp needs addr":     {"SA_MAIL_SINK": "smtp"},
		"memory only in test": {"SA_MAIL_SINK": "memory"},
		"unknown sink":        {"SA_MAIL_SINK": "pigeon"},
		"multi-line from":     {"SA_MAIL_FROM": "a@b.c\r\nBcc: x@y.z"},
	} {
		if _, err := LoadFrom(lookupFrom(env)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestCloudSettings(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(map[string]string{}))
	if err != nil || cfg.CloudEnabled || cfg.CloudTTL != 24*time.Hour || cfg.CloudPriceEgressGB != nil {
		t.Fatalf("Cloud is off by default with no prices: %+v %v", cfg.CloudEnabled, err)
	}
	cfg, err = LoadFrom(lookupFrom(map[string]string{"SA_CLOUD_ENABLED": "true", "SA_S3_ENDPOINT": "http://s3:7070/",
		"SA_S3_ACCESS_KEY": "a", "SA_S3_SECRET_KEY": "b", "SA_CLOUD_PRICE_EGRESS_GB": "0.09", "SA_CLOUD_TTL": "2h"}))
	if err != nil || !cfg.CloudEnabled || cfg.S3Endpoint != "http://s3:7070" || cfg.CloudPriceEgressGB == nil || *cfg.CloudPriceEgressGB != 0.09 ||
		cfg.CloudPriceStorageGB != nil || cfg.CloudTTL != 2*time.Hour {
		t.Fatalf("enabled: %+v %v", cfg, err)
	}
	for _, env := range []map[string]string{
		{"SA_CLOUD_ENABLED": "yes"},
		{"SA_CLOUD_ENABLED": "true"}, // no endpoint or keys
		{"SA_CLOUD_ENABLED": "true", "SA_S3_ENDPOINT": "s3:7070", "SA_S3_ACCESS_KEY": "a", "SA_S3_SECRET_KEY": "b"},
		{"SA_CLOUD_ENABLED": "true", "SA_CLOUD_STORE": "disk"},
		{"SA_CLOUD_TTL": "10s"},
		{"SA_CLOUD_PRICE_STORAGE_GB_MONTH": "-1"},
		{"SA_CLOUD_DEFAULT_BUDGET_BYTES": "100", "SA_CLOUD_MAX_BUDGET_BYTES": "10"},
		{"SA_ENV": "production", "SA_CLOUD_ENABLED": "true", "SA_CLOUD_STORE": "memory", "DATABASE_URL": "postgres://x",
			"SA_ALLOWED_ORIGINS": "https://a.example", "SA_TOKEN_KEYS": "k:" + seed32, "SA_TOKEN_ACTIVE_KID": "k", "SA_SERVER_SECRET": seed32,
			"SA_TURN_SECRET": strings.Repeat("t", 20)},
	} {
		if _, err := LoadFrom(lookupFrom(env)); err == nil {
			t.Errorf("%v should fail", env)
		}
	}
	if _, err := LoadFrom(lookupFrom(map[string]string{"SA_CLOUD_ENABLED": "true", "SA_CLOUD_STORE": "memory"})); err != nil {
		t.Fatalf("memory store in development: %v", err)
	}
}
