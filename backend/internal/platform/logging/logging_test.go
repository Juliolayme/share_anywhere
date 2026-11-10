package logging

import (
	"bytes"
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
	jwt := "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJkZXZpY2UtMTIzNCJ9.c2lnbmF0dXJlLXZhbHVl"
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
