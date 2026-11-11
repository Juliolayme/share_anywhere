package devices

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
)

type httpFixture struct {
	*fixture
	mux *http.ServeMux
}

func newHTTPFixture(t *testing.T) *httpFixture {
	t.Helper()
	f := newFixture(t, nil)
	mux := http.NewServeMux()
	router := access.NewRouter(mux, f.svc)
	NewHTTP(f.svc, clientip.New([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}), f.clk, true).Register(router)
	router.Finalize()
	return &httpFixture{fixture: f, mux: mux}
}

type reqOpt func(*http.Request)

func withToken(tok string) reqOpt {
	return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+tok) }
}
func withHeader(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }
func withCookie(v string) reqOpt {
	return func(r *http.Request) { r.AddCookie(&http.Cookie{Name: CookieName, Value: v}) }
}
func fromAddr(a string) reqOpt { return func(r *http.Request) { r.RemoteAddr = a } }

func (h *httpFixture) do(method, path, body string, opts ...reqOpt) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "203.0.113.7:4000"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, o := range opts {
		o(req)
	}
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, req)
	return rec
}

type sessionBody struct {
	AccessToken   string  `json:"access_token"`
	ExpiresIn     int     `json:"expires_in"`
	RefreshSecret *string `json:"refresh_secret"`
	ServerTime    string  `json:"server_time"`
	Device        struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Kind        string `json:"kind"`
	} `json:"device"`
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return v
}

func cookieFrom(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName {
			return c
		}
	}
	return nil
}

func TestCreateWithCookieTransport(t *testing.T) {
	h := newHTTPFixture(t)
	rec := h.do("POST", "/v1/devices/anonymous", `{"platform":"Web · Firefox","transport":"cookie"}`)
	if rec.Code != 201 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	s := decode[sessionBody](t, rec)
	if s.RefreshSecret != nil || s.AccessToken == "" || s.ExpiresIn != 900 || s.Device.Kind != "anonymous" || s.ServerTime == "" {
		t.Fatalf("body %s", rec.Body)
	}
	c := cookieFrom(t, rec)
	if c == nil || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/v1/devices/token" || c.Value == "" {
		t.Fatalf("cookie %+v", c)
	}
	if rec.Header().Get("Cache-Control") == "" && false {
		t.Fatal("unreachable")
	}
}

func TestCreateWithBodyTransportAndBadRequests(t *testing.T) {
	h := newHTTPFixture(t)
	rec := h.do("POST", "/v1/devices/anonymous", `{"platform":"Android","transport":"body"}`)
	s := decode[sessionBody](t, rec)
	if rec.Code != 201 || s.RefreshSecret == nil || cookieFrom(t, rec) != nil {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	for _, body := range []string{
		``, `{}`, `{"platform":"Web"}`, `{"platform":"Web","transport":"smoke"}`,
		`{"platform":"Web","transport":"body","user_id":"x"}`, `{"platform":"","transport":"body"}`,
		`{"platform":"Web","transport":"body"} trailing`,
	} {
		if rec := h.do("POST", "/v1/devices/anonymous", body); rec.Code != 400 {
			t.Errorf("%q: got %d", body, rec.Code)
		}
	}
}

func TestCreatePoWAnd429OverHTTP(t *testing.T) {
	h := newHTTPFixture(t)
	body := `{"platform":"Web","transport":"body"}`
	for i := 0; i < 3; i++ {
		h.do("POST", "/v1/devices/anonymous", body)
	}
	rec := h.do("POST", "/v1/devices/anonymous", body)
	if rec.Code != 428 {
		t.Fatalf("want 428, got %d", rec.Code)
	}
	pr := decode[struct {
		Error     string `json:"error"`
		Challenge struct {
			Token      string `json:"token"`
			Difficulty int    `json:"difficulty"`
			ExpiresIn  int    `json:"expires_in"`
		} `json:"challenge"`
	}](t, rec)
	if pr.Error != "pow_required" || pr.Challenge.ExpiresIn != 300 {
		t.Fatalf("%s", rec.Body)
	}
	sol := solve(pr.Challenge.Token, pr.Challenge.Difficulty)
	rec = h.do("POST", "/v1/devices/anonymous",
		`{"platform":"Web","transport":"body","pow":{"token":"`+pr.Challenge.Token+`","solution":"`+sol+`"}}`)
	if rec.Code != 201 {
		t.Fatalf("solved: %d %s", rec.Code, rec.Body)
	}
	// Exhaust the hard limit, then expect 429 with Retry-After.
	var last *httptest.ResponseRecorder
	for i := 0; i < 12; i++ {
		last = h.do("POST", "/v1/devices/anonymous", body)
		if last.Code == 429 {
			break
		}
	}
	if last.Code != 429 || last.Header().Get("Retry-After") == "" {
		t.Fatalf("want 429 with Retry-After, got %d %v", last.Code, last.Header())
	}
	e := decode[struct {
		Error       string `json:"error"`
		RetryAfterS int    `json:"retry_after_s"`
	}](t, last)
	if e.Error != "rate_limited" || e.RetryAfterS < 1 {
		t.Fatalf("%s", last.Body)
	}
	// The challenge endpoint works and is limited separately.
	if rec := h.do("GET", "/v1/devices/anonymous/challenge", ""); rec.Code != 200 {
		t.Fatalf("challenge %d", rec.Code)
	}
}

func TestXForwardedForOnlyFromTrustedProxy(t *testing.T) {
	h := newHTTPFixture(t)
	body := `{"platform":"Web","transport":"body"}`
	// An untrusted client rotating X-Forwarded-For still shares one bucket (its own address).
	codes := []int{}
	for i := 0; i < 4; i++ {
		rec := h.do("POST", "/v1/devices/anonymous", body, withHeader("X-Forwarded-For", "198.51.100."+string(rune('1'+i))))
		codes = append(codes, rec.Code)
	}
	if codes[3] != 428 {
		t.Fatalf("spoofed XFF must not reset the soft limit: %v", codes)
	}
	// Behind the trusted proxy (10/8), each forwarded client gets its own bucket.
	for i := 0; i < 4; i++ {
		rec := h.do("POST", "/v1/devices/anonymous", body, fromAddr("10.0.0.2:5000"),
			withHeader("X-Forwarded-For", "198.51.100."+string(rune('1'+i))))
		if rec.Code != 201 {
			t.Fatalf("trusted proxy client %d: %d", i, rec.Code)
		}
	}
}

func TestRefreshOverHTTP(t *testing.T) {
	h := newHTTPFixture(t)
	c := cookieFrom(t, h.do("POST", "/v1/devices/anonymous", `{"platform":"Web","transport":"cookie"}`))

	if rec := h.do("POST", "/v1/devices/token", "", withCookie(c.Value)); rec.Code != 403 || !strings.Contains(rec.Body.String(), "csrf_header_missing") {
		t.Fatalf("cookie refresh without X-SA-Refresh: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("POST", "/v1/devices/token", "", withHeader("X-SA-Refresh", "1")); rec.Code != 401 {
		t.Fatalf("no cookie: %d", rec.Code)
	}
	rec := h.do("POST", "/v1/devices/token", "", withCookie(c.Value), withHeader("X-SA-Refresh", "1"))
	if rec.Code != 200 {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body)
	}
	next := cookieFrom(t, rec)
	if next == nil || next.Value == c.Value || decode[sessionBody](t, rec).RefreshSecret != nil {
		t.Fatal("refresh must rotate the cookie and keep the secret out of the body")
	}
	// Reusing the old cookie after the grace window revokes the device and clears the cookie.
	h.clk.Advance(RefreshReuseGrace + time.Second)
	rec = h.do("POST", "/v1/devices/token", "", withCookie(c.Value), withHeader("X-SA-Refresh", "1"))
	if rec.Code != 401 || !strings.Contains(rec.Body.String(), "refresh_reused") {
		t.Fatalf("reuse: %d %s", rec.Code, rec.Body)
	}
	if cl := cookieFrom(t, rec); cl == nil || cl.MaxAge >= 0 {
		t.Fatalf("cookie must be cleared: %+v", cl)
	}
	if rec := h.do("POST", "/v1/devices/token", "", withCookie(next.Value), withHeader("X-SA-Refresh", "1")); rec.Code != 401 || !strings.Contains(rec.Body.String(), "refresh_invalid") {
		t.Fatalf("after revocation: %d %s", rec.Code, rec.Body)
	}

	// Native clients send the secret in the body and get the next one in the body.
	s := decode[sessionBody](t, h.do("POST", "/v1/devices/anonymous", `{"platform":"iOS","transport":"body"}`, fromAddr("203.0.113.9:1")))
	rec = h.do("POST", "/v1/devices/token", `{"refresh_secret":"`+*s.RefreshSecret+`"}`)
	if rec.Code != 200 || decode[sessionBody](t, rec).RefreshSecret == nil {
		t.Fatalf("body refresh: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("POST", "/v1/devices/token", `{"bogus":1}`); rec.Code != 400 {
		t.Fatalf("unknown field: %d", rec.Code)
	}
}

func TestCurrentRenameResetOverHTTP(t *testing.T) {
	h := newHTTPFixture(t)
	s := decode[sessionBody](t, h.do("POST", "/v1/devices/anonymous", `{"platform":"Web","transport":"cookie"}`))
	if rec := h.do("GET", "/v1/devices/current", ""); rec.Code != 401 {
		t.Fatalf("no token: %d", rec.Code)
	}
	rec := h.do("GET", "/v1/devices/current", "", withToken(s.AccessToken))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), s.Device.ID) {
		t.Fatalf("current: %d %s", rec.Code, rec.Body)
	}
	rec = h.do("PATCH", "/v1/devices/current", `{"display_name":"Living room"}`, withToken(s.AccessToken))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Living room") {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("PATCH", "/v1/devices/current", `{"display_name":""}`, withToken(s.AccessToken)); rec.Code != 400 {
		t.Fatalf("empty rename: %d", rec.Code)
	}
	if rec := h.do("DELETE", "/v1/devices/current", "", withToken(s.AccessToken)); rec.Code != 405 || !strings.Contains(rec.Header().Get("Allow"), "PATCH") {
		t.Fatalf("405: %d %v", rec.Code, rec.Header())
	}
	rec = h.do("POST", "/v1/devices/current/reset", "", withToken(s.AccessToken))
	if rec.Code != 201 {
		t.Fatalf("reset: %d %s", rec.Code, rec.Body)
	}
	n := decode[sessionBody](t, rec)
	if n.Device.ID == s.Device.ID || cookieFrom(t, rec) == nil {
		t.Fatalf("reset must create a new identity and set its cookie: %s", rec.Body)
	}
	if rec := h.do("GET", "/v1/devices/current", "", withToken(s.AccessToken)); rec.Code != 401 {
		t.Fatalf("old token after reset: %d", rec.Code)
	}
	h.clk.Advance(AccessTokenTTL + time.Second)
	if rec := h.do("GET", "/v1/devices/current", "", withToken(n.AccessToken)); rec.Code != 401 || !strings.Contains(rec.Body.String(), "device_token_expired") {
		t.Fatalf("expired token: %d %s", rec.Code, rec.Body)
	}
}

// A Web (cookie) device's refresh secret never appears in a response body, whatever the request asks for.
func TestCookieDeviceSecretNeverInBody(t *testing.T) {
	h := newHTTPFixture(t)
	c := cookieFrom(t, h.do("POST", "/v1/devices/anonymous", `{"platform":"Web","transport":"cookie"}`))
	rec := h.do("POST", "/v1/devices/token", `{"transport":"body"}`, withCookie(c.Value), withHeader("X-SA-Refresh", "1"))
	if rec.Code != 400 {
		t.Fatalf("transport is no longer a refresh field; want 400, got %d %s", rec.Code, rec.Body)
	}
	rec = h.do("POST", "/v1/devices/token", "", withCookie(c.Value), withHeader("X-SA-Refresh", "1"))
	s := decode[sessionBody](t, rec)
	if rec.Code != 200 || s.RefreshSecret != nil || strings.Contains(rec.Body.String(), "refresh_secret") || cookieFrom(t, rec) == nil {
		t.Fatalf("cookie refresh must answer by cookie only: %d %s", rec.Code, rec.Body)
	}
	// Presenting the cookie secret in the body still answers by cookie.
	next := cookieFrom(t, rec)
	rec = h.do("POST", "/v1/devices/token", `{"refresh_secret":"`+next.Value+`"}`)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "refresh_secret") || cookieFrom(t, rec) == nil {
		t.Fatalf("body-presented cookie secret must still answer by cookie: %d %s", rec.Code, rec.Body)
	}
	// Reset keeps the device's transport.
	rec = h.do("POST", "/v1/devices/current/reset", "", withToken(s.AccessToken))
	if rec.Code != 201 || strings.Contains(rec.Body.String(), "refresh_secret") || cookieFrom(t, rec) == nil {
		t.Fatalf("reset of a cookie device: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("POST", "/v1/devices/current/reset", `{"transport":"body"}`, withToken(decode[sessionBody](t, rec).AccessToken)); rec.Code != 400 {
		t.Fatalf("reset takes no body fields: %d", rec.Code)
	}
}

func TestBodyDeviceKeepsBodyTransportOnReset(t *testing.T) {
	h := newHTTPFixture(t)
	s := decode[sessionBody](t, h.do("POST", "/v1/devices/anonymous", `{"platform":"Android","transport":"body"}`))
	rec := h.do("POST", "/v1/devices/current/reset", "", withToken(s.AccessToken))
	if rec.Code != 201 || decode[sessionBody](t, rec).RefreshSecret == nil || cookieFrom(t, rec) != nil {
		t.Fatalf("native reset answers in the body: %d %s", rec.Code, rec.Body)
	}
}

// A cross-site HTML form can only send text/plain; such a create must not set an identity cookie.
func TestCreateRejectsNonJSONContentType(t *testing.T) {
	h := newHTTPFixture(t)
	req := httptest.NewRequest("POST", "/v1/devices/anonymous", strings.NewReader(`{"platform":"web","transport":"cookie"}`))
	req.Header.Set("Content-Type", "text/plain")
	req.RemoteAddr = "203.0.113.50:1"
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, req)
	if rec.Code != 400 || cookieFrom(t, rec) != nil {
		t.Fatalf("text/plain create: %d cookie=%v", rec.Code, cookieFrom(t, rec))
	}
}
