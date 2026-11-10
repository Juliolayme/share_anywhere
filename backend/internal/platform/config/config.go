// Package config loads and validates backend configuration from the environment.
package config

import (
	"errors"
	"fmt"
	"os"
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
