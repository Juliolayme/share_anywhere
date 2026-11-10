package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRateLimitedHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	RateLimited(rec, "rate_limited", 1500*time.Millisecond)
	if rec.Code != 429 || rec.Header().Get("Retry-After") != "2" || !strings.Contains(rec.Body.String(), `"retry_after_s":2`) {
		t.Fatalf("got %d %v %s", rec.Code, rec.Header(), rec.Body.String())
	}
	if RetryAfterSeconds(0) != 1 {
		t.Fatal("minimum retry is 1 second")
	}
}

func jsonReq(body string) *http.Request {
	r := httptest.NewRequest("POST", "/", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json; charset=utf-8")
	return r
}

func TestDecode(t *testing.T) {
	type body struct {
		Name string `json:"name"`
	}
	var b body
	if err := Decode(jsonReq(`{"name":"x"}`), &b, 1024, false); err != nil || b.Name != "x" {
		t.Fatalf("valid body: %v %+v", err, b)
	}
	for _, bad := range []string{`{"name":1}`, `{"other":"x"}`, `{"name":"x"}{}`, `not json`, ``} {
		if err := Decode(jsonReq(bad), &b, 1024, false); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
	// A cross-site form can post text/plain JSON-looking bodies; only application/json is accepted.
	for _, ct := range []string{"text/plain", "application/x-www-form-urlencoded", ""} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(`{"name":"x"}`))
		if ct != "" {
			r.Header.Set("Content-Type", ct)
		}
		if err := Decode(r, &b, 1024, true); err == nil {
			t.Fatalf("content type %q must be rejected", ct)
		}
	}
	if err := Decode(httptest.NewRequest("POST", "/", strings.NewReader(``)), &b, 1024, true); err != nil {
		t.Fatalf("empty allowed: %v", err)
	}
	if err := Decode(httptest.NewRequest("POST", "/", strings.NewReader(`{"name":"`+strings.Repeat("a", 2000)+`"}`)), &b, 100, false); err == nil {
		t.Fatal("expected size limit error")
	}
}
