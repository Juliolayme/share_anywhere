package logging

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestRedactsSensitiveKeys(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, "debug")
	log.Info("event",
		"access_token", "abc", "refresh_secret", "def", "Authorization", "Bearer x",
		"email", "a@example.com", "code", "123456", "join_code", "654321",
		"client_ip", "203.0.113.9", "ws_ticket", "t1", "password", "hunter2",
	)
	out := buf.String()
	for _, leaked := range []string{"abc", "def", "Bearer x", "a@example.com", "123456", "654321", "203.0.113.9", "t1", "hunter2"} {
		if strings.Contains(out, leaked) {
			t.Fatalf("log leaked %q: %s", leaked, out)
		}
	}
	if strings.Count(out, Redacted) != 9 {
		t.Fatalf("expected 9 redactions, got %d: %s", strings.Count(out, Redacted), out)
	}
}

func TestKeepsSafeKeys(t *testing.T) {
	var buf bytes.Buffer
	New(&buf, "info").Info("req", "status_code", 200, "description", "fine", "path", "/healthz", "zip", "kept")
	out := buf.String()
	for _, kept := range []string{`"status_code":200`, `"description":"fine"`, `"path":"/healthz"`, `"zip":"kept"`} {
		if !strings.Contains(out, kept) {
			t.Fatalf("expected %s in %s", kept, out)
		}
	}
}

func TestRedactsJWTLikeValues(t *testing.T) {
	var buf bytes.Buffer
	// Built at runtime so secret scanners do not flag a literal token in the repository.
	jwt := fakeJWT()
	New(&buf, "info").Info("oops", "detail", "header was "+jwt)
	if strings.Contains(buf.String(), jwt) {
		t.Fatalf("JWT leaked: %s", buf.String())
	}
}

func TestLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf, "warn")
	l.Info("hidden")
	l.Warn("shown")
	if strings.Contains(buf.String(), "hidden") || !strings.Contains(buf.String(), "shown") {
		t.Fatalf("level filtering wrong: %s", buf.String())
	}
}

// fakeJWT returns a JWT-shaped string (header.payload.signature) for redaction tests.
func fakeJWT() string {
	part := func(s string) string { return s + strings.Repeat("A", 12) }
	return "eyJ" + part("hbG") + "." + part("eyJzdWI") + "." + part("c2ln")
}

func TestRedactsTokensInsideErrors(t *testing.T) {
	var buf bytes.Buffer
	jwt := fakeJWT()
	New(&buf, "info").Error("upstream failed", "error", fmt.Errorf("wrap: %w", errors.New("bad header "+jwt)))
	if strings.Contains(buf.String(), jwt) {
		t.Fatalf("JWT inside error leaked: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "wrap: bad header") {
		t.Fatalf("error text should be kept apart from the token: %s", buf.String())
	}
}

func TestRedactsMembersOfSensitiveGroups(t *testing.T) {
	var buf bytes.Buffer
	New(&buf, "info").Info("grouped", slog.Group("refresh", "value", "s3cr3t", "id", "x1"), slog.Group("req", "path", "/v1/x"))
	out := buf.String()
	if strings.Contains(out, "s3cr3t") || strings.Contains(out, `"x1"`) {
		t.Fatalf("sensitive group leaked: %s", out)
	}
	if !strings.Contains(out, `"path":"/v1/x"`) {
		t.Fatalf("non-sensitive group should be kept: %s", out)
	}
}
