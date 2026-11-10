// Package logging builds the structured JSON logger with redaction of secrets and personal data.
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
)

// Redacted replaces any value the logger must never print.
const Redacted = "[REDACTED]"

// sensitiveSubstrings redact any key that contains them (case-insensitive).
var sensitiveSubstrings = []string{
	"token", "secret", "password", "passwd", "authorization", "cookie",
	"email", "ticket", "capability", "refresh", "ciphertext", "clipboard",
	"verification_words", "security_words", "forwarded",
}

// sensitiveWords redact keys that contain them as a whole word (split on _ . -),
// so "client_ip" and "join_code" are redacted but "zip" and "description" are not.
var sensitiveWords = map[string]bool{"ip": true, "code": true, "pin": true}

// safeKeys are allowed even though they contain a sensitive word.
var safeKeys = map[string]bool{"status_code": true, "http_code": true, "error_code": true, "ip_hash": true}

var jwtLike = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)

// IsSensitiveKey reports whether an attribute with this key must be redacted.
func IsSensitiveKey(key string) bool {
	k := strings.ToLower(key)
	if safeKeys[k] {
		return false
	}
	for _, s := range sensitiveSubstrings {
		if strings.Contains(k, s) {
			return true
		}
	}
	for _, w := range strings.FieldsFunc(k, func(r rune) bool { return r == '_' || r == '.' || r == '-' }) {
		if sensitiveWords[w] {
			return true
		}
	}
	return false
}

// Replace is a slog ReplaceAttr function that redacts sensitive attributes and JWT-like strings.
// slog does not call ReplaceAttr for group attributes themselves, so a sensitive group name
// (for example slog.Group("token", ...)) is detected through the groups path of its members.
func Replace(groups []string, a slog.Attr) slog.Attr {
	for _, g := range groups {
		if IsSensitiveKey(g) {
			return slog.String(a.Key, Redacted)
		}
	}
	if IsSensitiveKey(a.Key) {
		return slog.String(a.Key, Redacted)
	}
	v := a.Value.Resolve()
	switch v.Kind() {
	case slog.KindString:
		if jwtLike.MatchString(v.String()) {
			return slog.String(a.Key, jwtLike.ReplaceAllString(v.String(), Redacted))
		}
	case slog.KindAny:
		// Errors and other values are printed with their String/Error text; scrub tokens from it.
		if text := fmt.Sprint(v.Any()); jwtLike.MatchString(text) {
			return slog.String(a.Key, jwtLike.ReplaceAllString(text, Redacted))
		}
	}
	return a
}

// New returns a JSON logger writing to w at the given level ("debug", "info", "warn", "error").
func New(w io.Writer, level string) *slog.Logger {
	var lv slog.Level
	switch level {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lv, ReplaceAttr: Replace}))
}
