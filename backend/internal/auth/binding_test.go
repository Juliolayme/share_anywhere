package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
)

// refreshWeb calls POST /v1/devices/token the way the Web does: sa_device cookie, X-SA-Refresh header, and
// the sa_acct cookie when acct is not empty.
func (e *env) refreshWeb(secret, acct string) resp {
	e.t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/devices/token", strings.NewReader(""))
	req.RemoteAddr = "192.0.2.1:40000"
	req.Header.Set("X-SA-Refresh", "1")
	req.AddCookie(&http.Cookie{Name: devices.CookieName, Value: secret})
	if acct != "" {
		req.AddCookie(&http.Cookie{Name: devices.AccountCookieName, Value: acct})
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	out := resp{code: rec.Code, raw: rec.Body.String(), hdr: rec.Header()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.body)
	if rec.Code != http.StatusOK {
		e.t.Fatalf("refresh: %d %s", rec.Code, rec.Body.String())
	}
	return out
}

func (r resp) newSecret(t *testing.T) string {
	t.Helper()
	c := cookie(r, devices.CookieName)
	if c == nil || c.Value == "" {
		t.Fatalf("refresh must rotate the sa_device cookie: %q", r.hdr.Values("Set-Cookie"))
	}
	return c.Value
}

func (e *env) sessionBinding(deviceID string) (bound bool, live bool) {
	e.t.Helper()
	_ = e.pool.QueryRow(ctx, `SELECT browser_binding IS NOT NULL, true FROM auth_sessions WHERE device_id = $1::uuid AND revoked_at IS NULL`,
		deviceID).Scan(&bound, &live)
	return bound, live
}

// signinNotAdded signs a new Web device in without adding it and returns the device, its sa_acct value, and
// the sign-in response.
func (e *env) signinNotAdded(email string) (devices.Session, string, resp) {
	e.t.Helper()
	d := e.device()
	r := e.doFrom(e.ip(), "POST", "/v1/auth/signin", d.AccessToken, map[string]any{"email": email, "password": testPassword, "add_device": false})
	e.want(r, 200, "")
	c := cookie(r, devices.AccountCookieName)
	if c == nil {
		e.t.Fatalf("not-added Web sign-in must set sa_acct: %q", r.hdr.Values("Set-Cookie"))
	}
	return d, c.Value, r
}

// TestNotAddedWebSessionBoundToBrowser (QA P1-1): a not-added Web session lives only as long as the browser
// session that holds its sa_acct cookie; a refresh without it (browser restarted, cookie copied without it)
// ends the account session and yields a guest token, and the device leaves the account.
func TestNotAddedWebSessionBoundToBrowser(t *testing.T) {
	e := newEnv(t)
	e.signup("uma@example.com", true)
	d, acct, r := e.signinNotAdded("uma@example.com")
	c := cookie(r, devices.AccountCookieName)
	if len(acct) < 43 || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/v1/devices/token" ||
		c.MaxAge != 0 || !c.Expires.IsZero() || strings.Contains(strings.Join(r.hdr.Values("Set-Cookie"), ";"), "Max-Age") {
		t.Fatalf("sa_acct must be a 256-bit HttpOnly, SameSite=Strict, Secure browser-session cookie on the refresh path: %q", r.hdr.Values("Set-Cookie"))
	}
	if bound, live := e.sessionBinding(d.Device.ID); !bound || !live {
		t.Fatal("the session must store the binding")
	}

	// With the cookie: still signed in (dl=false), and the cookie is kept.
	out := e.refreshWeb(d.Secret, acct)
	if id := e.ident(out.str("access_token")); id.AccountID == "" || id.DeviceAdded {
		t.Fatalf("bound refresh must keep the account session: %+v", id)
	}
	if cookie(out, devices.AccountCookieName) != nil {
		t.Fatal("a matching refresh must not touch sa_acct")
	}
	secret := out.newSecret(t)

	// A wrong value ends it like a missing one.
	out = e.refreshWeb(secret, acct+"x")
	guest := out.str("access_token")
	if id := e.ident(guest); id.AccountID != "" || id.DeviceID != d.Device.ID {
		t.Fatalf("unbound refresh must yield a guest token for the same device: %+v", id)
	}
	if c := cookie(out, devices.AccountCookieName); c == nil || c.MaxAge >= 0 {
		t.Fatalf("an ended session clears the presented sa_acct: %q", out.hdr.Values("Set-Cookie"))
	}
	if _, live := e.sessionBinding(d.Device.ID); live {
		t.Fatal("the account session must have ended")
	}
	e.want(e.do("GET", "/v1/me", guest, nil), 403, "account_required")
	// Ending is final: presenting the right cookie later does not bring the session back.
	if id := e.ident(e.refreshWeb(out.newSecret(t), acct).str("access_token")); id.AccountID != "" {
		t.Fatal("an ended session must stay ended")
	}

	// Without the cookie at all (browser restarted): ended too.
	d2, _, _ := e.signinNotAdded("uma@example.com")
	out = e.refreshWeb(d2.Secret, "")
	if id := e.ident(out.str("access_token")); id.AccountID != "" {
		t.Fatalf("refresh without sa_acct must end the session: %+v", id)
	}
	var kind string
	_ = e.pool.QueryRow(ctx, `SELECT kind FROM devices WHERE id = $1::uuid`, d2.Device.ID).Scan(&kind)
	if _, live := e.sessionBinding(d2.Device.ID); live || kind != "anonymous" {
		t.Fatalf("the device must leave the account: live session, kind %q", kind)
	}
}

// TestAddClearsBinding: Add this device turns the session into an added one, drops the binding, and clears
// the cookie; later refreshes need no sa_acct.
func TestAddClearsBinding(t *testing.T) {
	e := newEnv(t)
	e.signup("val@example.com", true)
	d, _, r := e.signinNotAdded("val@example.com")
	add := e.do("POST", "/v1/devices/current/add", r.str("access_token"), nil)
	e.want(add, 200, "")
	if c := cookie(add, devices.AccountCookieName); c == nil || c.MaxAge >= 0 {
		t.Fatalf("add must clear sa_acct: %q", add.hdr.Values("Set-Cookie"))
	}
	if bound, live := e.sessionBinding(d.Device.ID); bound || !live {
		t.Fatalf("add must drop the binding: bound=%v live=%v", bound, live)
	}
	out := e.refreshWeb(d.Secret, "")
	if id := e.ident(out.str("access_token")); id.AccountID == "" || !id.DeviceAdded {
		t.Fatalf("an added device refreshes without sa_acct: %+v", id)
	}
	// An added sign-in sets no binding (and clears a stale cookie).
	b := e.device()
	r = e.doFrom(e.ip(), "POST", "/v1/auth/signin", b.AccessToken, map[string]any{"email": "val@example.com", "password": testPassword})
	e.want(r, 200, "")
	if c := cookie(r, devices.AccountCookieName); c == nil || c.MaxAge >= 0 {
		t.Fatalf("an added Web sign-in clears sa_acct: %q", r.hdr.Values("Set-Cookie"))
	}
	if bound, _ := e.sessionBinding(b.Device.ID); bound {
		t.Fatal("an added session has no binding")
	}
	// Resetting the identity clears the cookie with the old session.
	reset := e.do("POST", "/v1/devices/current/reset", r.str("access_token"), nil)
	e.want(reset, 201, "")
	if c := cookie(reset, devices.AccountCookieName); c == nil || c.MaxAge >= 0 {
		t.Fatalf("reset must clear sa_acct: %q", reset.hdr.Values("Set-Cookie"))
	}
}

// TestNativeNotAddedSessionUnbound: native (body-transport) devices get no binding and no cookie; their
// not-added session keeps the 24 h limit only.
func TestNativeNotAddedSessionUnbound(t *testing.T) {
	e := newEnv(t)
	e.signup("wes@example.com", true)
	d, err := e.dev.Create(ctx, "native-b", devices.CreateInput{Platform: "Android", Transport: devices.TransportBody})
	if err != nil {
		t.Fatal(err)
	}
	r := e.doFrom(e.ip(), "POST", "/v1/auth/signin", d.AccessToken, map[string]any{"email": "wes@example.com", "password": testPassword, "add_device": false})
	e.want(r, 200, "")
	if len(r.hdr.Values("Set-Cookie")) != 0 {
		t.Fatalf("native sign-in sets no cookie: %q", r.hdr.Values("Set-Cookie"))
	}
	if bound, live := e.sessionBinding(d.Device.ID); bound || !live {
		t.Fatalf("native session: bound=%v live=%v", bound, live)
	}
	s, err := e.dev.Refresh(ctx, d.Secret)
	if err != nil || s.Account.AccountID == "" || s.Account.Added {
		t.Fatalf("native not-added refresh keeps the session: %+v %v", s.Account, err)
	}
}
