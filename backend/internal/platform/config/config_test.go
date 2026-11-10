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

func TestOriginsAreTrimmed(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(map[string]string{"SA_ALLOWED_ORIGINS": " https://a.example/ , http://localhost:5173 "}))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[0] != "https://a.example" || cfg.AllowedOrigins[1] != "http://localhost:5173" {
		t.Fatalf("unexpected origins %#v", cfg.AllowedOrigins)
	}
}
