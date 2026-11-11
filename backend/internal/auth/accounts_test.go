package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
)

func TestSignUpSignInSignOut(t *testing.T) {
	e := newEnv(t)
	a := e.device()
	r := e.do("POST", "/v1/auth/signup", a.AccessToken, map[string]any{"email": "Alice@Example.com", "password": testPassword})
	e.want(r, 201, "")
	acct := r.body["account"].(map[string]any)
	dev := r.body["device"].(map[string]any)
	if acct["email"] != "alice@example.com" || dev["id"] != a.Device.ID || dev["added"] != true {
		t.Fatalf("signup body: %s", r.raw)
	}
	tokA := r.str("access_token")
	id := e.ident(tokA)
	if id.DeviceID != a.Device.ID || id.AccountID != acct["id"] || !id.DeviceAdded {
		t.Fatalf("claims: %+v", id)
	}
	var kind string
	_ = e.pool.QueryRow(ctx, `SELECT kind FROM devices WHERE id = $1::uuid`, a.Device.ID).Scan(&kind)
	if kind != "account" {
		t.Fatalf("added device kind = %q", kind)
	}

	// Duplicate email, already signed in, weak password, bad email.
	e.want(e.doFrom(e.ip(), "POST", "/v1/auth/signup", e.device().AccessToken, map[string]any{"email": "alice@example.com", "password": testPassword}), 409, "email_taken")
	e.want(e.do("POST", "/v1/auth/signup", tokA, map[string]any{"email": "x@example.com", "password": testPassword}), 409, "already_signed_in")
	e.want(e.do("POST", "/v1/auth/signin", tokA, map[string]any{"email": "alice@example.com", "password": testPassword}), 409, "already_signed_in")
	e.want(e.do("POST", "/v1/auth/signup", e.device().AccessToken, map[string]any{"email": "bob@example.com", "password": "short"}), 400, "weak_password")
	e.want(e.do("POST", "/v1/auth/signup", e.device().AccessToken, map[string]any{"email": "not-an-email", "password": testPassword}), 400, "invalid_email")

	me := e.do("GET", "/v1/me", tokA, nil)
	e.want(me, 200, "")
	if me.str("email") != "alice@example.com" || me.body["history_sync"] != false || me.body["device"].(map[string]any)["added"] != true {
		t.Fatalf("me: %s", me.raw)
	}
	e.want(e.do("PATCH", "/v1/me", tokA, map[string]any{"history_sync": true}), 200, "")
	if e.do("GET", "/v1/me", tokA, nil).body["history_sync"] != true {
		t.Fatal("history_sync not saved")
	}

	// Wrong password and unknown email get the same answer.
	b := e.device()
	wrong := e.do("POST", "/v1/auth/signin", b.AccessToken, map[string]any{"email": "alice@example.com", "password": "not the password"})
	unknown := e.do("POST", "/v1/auth/signin", b.AccessToken, map[string]any{"email": "nobody@example.com", "password": "not the password"})
	e.want(wrong, 401, "invalid_credentials")
	e.want(unknown, 401, "invalid_credentials")
	if wrong.raw != unknown.raw {
		t.Fatalf("responses differ: %s vs %s", wrong.raw, unknown.raw)
	}

	// Sign out: new device ID, Web cookie, old identity and account session revoked.
	out := e.do("POST", "/v1/auth/signout", tokA, nil)
	e.want(out, 200, "")
	newDev := out.body["device"].(map[string]any)
	if newDev["id"] == a.Device.ID || newDev["kind"] != "anonymous" || out.body["refresh_secret"] != nil {
		t.Fatalf("signout body: %s", out.raw)
	}
	if c := out.hdr.Get("Set-Cookie"); !strings.Contains(c, devices.CookieName+"=") || !strings.Contains(c, "HttpOnly") {
		t.Fatalf("signout must set a new sa_device cookie: %q", c)
	}
	e.want(e.do("GET", "/v1/me", tokA, nil), 401, "device_token_invalid")
	guest := out.str("access_token")
	if g := e.ident(guest); g.AccountID != "" || g.DeviceID != newDev["id"] {
		t.Fatalf("new identity must be a guest: %+v", g)
	}
	e.want(e.do("GET", "/v1/me", guest, nil), 403, "account_required")
	var revoked bool
	_ = e.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM auth_sessions WHERE device_id = $1::uuid`, a.Device.ID).Scan(&revoked)
	_ = e.pool.QueryRow(ctx, `SELECT kind FROM devices WHERE id = $1::uuid`, a.Device.ID).Scan(&kind)
	if !revoked || kind != "anonymous" {
		t.Fatalf("old account session revoked=%v, old device kind=%q", revoked, kind)
	}
	// The new guest can sign in again.
	e.want(e.do("POST", "/v1/auth/signin", guest, map[string]any{"email": "alice@example.com", "password": testPassword}), 200, "")
}

func TestSignOutNativeGetsSecretInBody(t *testing.T) {
	e := newEnv(t)
	d, err := e.dev.Create(ctx, "native", devices.CreateInput{Platform: "Android", Transport: devices.TransportBody})
	if err != nil {
		t.Fatal(err)
	}
	r := e.do("POST", "/v1/auth/signup", d.AccessToken, map[string]any{"email": "n@example.com", "password": testPassword})
	e.want(r, 201, "")
	out := e.do("POST", "/v1/auth/signout", r.str("access_token"), nil)
	e.want(out, 200, "")
	if out.str("refresh_secret") == "" || out.hdr.Get("Set-Cookie") != "" {
		t.Fatalf("native sign-out must return the refresh secret in the body only: %s", out.raw)
	}
	if _, err := e.dev.Refresh(ctx, out.str("refresh_secret")); err != nil {
		t.Fatalf("new secret must refresh: %v", err)
	}
}

// TestSignInKeepsDeviceAndNotAddedExpires: sign-in keeps the device ID (running transfers continue); a
// not-added device gets dl=false and an account session that ends 24 h after sign-in, even when used.
func TestSignInKeepsDeviceAndNotAddedExpires(t *testing.T) {
	e := newEnv(t)
	e.signup("carol@example.com", true)
	b := e.device()
	r := e.doFrom(e.ip(), "POST", "/v1/auth/signin", b.AccessToken, map[string]any{"email": "carol@example.com", "password": testPassword, "add_device": false})
	e.want(r, 200, "")
	if r.body["device"].(map[string]any)["id"] != b.Device.ID || r.body["device"].(map[string]any)["added"] != false {
		t.Fatalf("signin body: %s", r.raw)
	}
	tok := r.str("access_token")
	if id := e.ident(tok); id.DeviceID != b.Device.ID || id.AccountID == "" || id.DeviceAdded {
		t.Fatalf("claims: %+v", id)
	}
	var expires time.Time
	var kind string
	_ = e.pool.QueryRow(ctx, `SELECT expires_at FROM auth_sessions WHERE device_id = $1::uuid AND revoked_at IS NULL`, b.Device.ID).Scan(&expires)
	_ = e.pool.QueryRow(ctx, `SELECT kind FROM devices WHERE id = $1::uuid`, b.Device.ID).Scan(&kind)
	if !expires.Equal(t0.Add(24*time.Hour)) || kind != "anonymous" {
		t.Fatalf("not-added session expires %v (want %v), device kind %q", expires, t0.Add(24*time.Hour), kind)
	}
	e.want(e.do("GET", "/v1/keys", tok, nil), 403, "device_not_added")
	e.want(e.do("GET", "/v1/history/entries", tok, nil), 403, "device_not_added")
	e.want(e.do("GET", "/v1/me", tok, nil), 200, "")

	// Refreshing re-derives acct/dl and does not extend a not-added session.
	e.clk.Advance(23 * time.Hour)
	s, err := e.dev.Refresh(ctx, b.Secret)
	if err != nil || s.Account.AccountID == "" || s.Account.Added {
		t.Fatalf("refresh within 24 h: %+v %v", s.Account, err)
	}
	e.clk.Advance(2 * time.Hour)
	s2, err := e.dev.Refresh(ctx, s.Secret)
	if err != nil || s2.Account.AccountID != "" {
		t.Fatalf("after 24 h the device is a guest again: %+v %v", s2.Account, err)
	}
	if s2.Device.ID != b.Device.ID {
		t.Fatal("device ID must not change")
	}
	e.want(e.do("GET", "/v1/me", s2.AccessToken, nil), 403, "account_required")

	// Add this device later turns dl on.
	r = e.doFrom(e.ip(), "POST", "/v1/auth/signin", s2.AccessToken, map[string]any{"email": "carol@example.com", "password": testPassword, "add_device": false})
	e.want(r, 200, "")
	add := e.do("POST", "/v1/devices/current/add", r.str("access_token"), map[string]any{"copy_history": true})
	e.want(add, 200, "")
	if add.body["device"].(map[string]any)["added"] != true || !e.ident(add.str("access_token")).DeviceAdded {
		t.Fatalf("add: %s", add.raw)
	}
	_ = e.pool.QueryRow(ctx, `SELECT expires_at FROM auth_sessions WHERE device_id = $1::uuid AND revoked_at IS NULL`, b.Device.ID).Scan(&expires)
	if !expires.Equal(e.clk.Now().Add(AddedSessionIdle)) {
		t.Fatalf("added session must slide to 90 days: %v", expires)
	}
}

func TestAddedSessionSlidesOnRefresh(t *testing.T) {
	e := newEnv(t)
	d, _ := e.signup("dan@example.com", true)
	e.clk.Advance(60 * 24 * time.Hour)
	s, err := e.dev.Refresh(ctx, d.Secret)
	if err != nil || !s.Account.Added || s.Device.Kind != "account" {
		t.Fatalf("refresh: %+v %v", s, err)
	}
	if !s.Device.ExpiresAt.Equal(e.clk.Now().Add(devices.AccountLifetime)) {
		t.Fatalf("account device lifetime: %v", s.Device.ExpiresAt)
	}
	var expires time.Time
	_ = e.pool.QueryRow(ctx, `SELECT expires_at FROM auth_sessions WHERE device_id = $1::uuid AND revoked_at IS NULL`, d.Device.ID).Scan(&expires)
	if !expires.Equal(e.clk.Now().Add(AddedSessionIdle)) {
		t.Fatalf("session expiry %v", expires)
	}
}

func TestResetIdentityEndsAccountSession(t *testing.T) {
	e := newEnv(t)
	d, tok := e.signup("erin@example.com", true)
	r := e.do("POST", "/v1/devices/current/reset", tok, nil)
	e.want(r, 201, "")
	var n int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE device_id = $1::uuid AND revoked_at IS NULL`, d.Device.ID).Scan(&n)
	if n != 0 {
		t.Fatal("reset must end the old device's account session")
	}
	if e.ident(r.str("access_token")).AccountID != "" {
		t.Fatal("the reset identity is a guest")
	}
}

func TestPasswordResetSingleUse(t *testing.T) {
	e := newEnv(t)
	_, tokA := e.signup("frank@example.com", true)
	_, tokB := e.signin("frank@example.com", true)

	e.want(e.do("POST", "/v1/auth/password-reset/request", "", map[string]any{"email": "nobody@example.com"}), 202, "")
	if e.mail.Count() != 0 {
		t.Fatal("no mail for an unknown address")
	}
	e.want(e.do("POST", "/v1/auth/password-reset/request", "", map[string]any{"email": "not an email"}), 202, "")
	e.want(e.do("POST", "/v1/auth/password-reset/request", "", map[string]any{"email": "FRANK@example.com"}), 202, "")
	msg, ok := e.mail.Last("frank@example.com")
	if !ok || !strings.HasPrefix(msg.Link, "https://app.example/reset?token=") || !strings.Contains(msg.Body, msg.Link) {
		t.Fatalf("reset mail: %+v", msg)
	}
	token := strings.TrimPrefix(msg.Link, "https://app.example/reset?token=")
	if len(token) < 43 {
		t.Fatalf("token must carry at least 256 bits: %q", token)
	}
	var stored int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM password_resets WHERE token_hash = $1`, []byte(token)).Scan(&stored)
	if stored != 0 {
		t.Fatal("reset tokens must be stored hashed")
	}

	// A weak password does not consume the token.
	e.want(e.do("POST", "/v1/auth/password-reset/confirm", "", map[string]any{"token": token, "password": "short"}), 400, "weak_password")
	e.want(e.do("POST", "/v1/auth/password-reset/confirm", "", map[string]any{"token": token, "password": "a brand new secret"}), 204, "")
	e.want(e.do("POST", "/v1/auth/password-reset/confirm", "", map[string]any{"token": token, "password": "another new secret"}), 400, "reset_token_invalid")
	e.want(e.do("POST", "/v1/auth/password-reset/confirm", "", map[string]any{"token": "bogus", "password": "another new secret"}), 400, "reset_token_invalid")

	// Every account session ended.
	e.want(e.do("GET", "/v1/me", tokA, nil), 401, "device_token_invalid")
	e.want(e.do("GET", "/v1/me", tokB, nil), 401, "device_token_invalid")
	d := e.device()
	e.want(e.doFrom(e.ip(), "POST", "/v1/auth/signin", d.AccessToken, map[string]any{"email": "frank@example.com", "password": testPassword}), 401, "invalid_credentials")
	e.want(e.doFrom(e.ip(), "POST", "/v1/auth/signin", d.AccessToken, map[string]any{"email": "frank@example.com", "password": "a brand new secret"}), 200, "")

	// Expiry: a link older than 30 minutes no longer works.
	e.want(e.doFrom("203.0.113.9", "POST", "/v1/auth/password-reset/request", "", map[string]any{"email": "frank@example.com"}), 202, "")
	msg, _ = e.mail.Last("frank@example.com")
	e.clk.Advance(31 * time.Minute)
	e.want(e.do("POST", "/v1/auth/password-reset/confirm", "", map[string]any{"token": strings.TrimPrefix(msg.Link, "https://app.example/reset?token="), "password": "yet another secret"}), 400, "reset_token_invalid")
}

func TestChangePasswordEndsOtherSessions(t *testing.T) {
	e := newEnv(t)
	_, tokA := e.signup("gina@example.com", true)
	_, tokB := e.signin("gina@example.com", true)
	e.want(e.do("POST", "/v1/me/password", tokA, map[string]any{"current_password": "wrong password", "new_password": "a brand new secret"}), 403, "invalid_credentials")
	e.want(e.do("POST", "/v1/me/password", tokA, map[string]any{"current_password": testPassword, "new_password": "short"}), 400, "weak_password")
	e.want(e.do("POST", "/v1/me/password", tokA, map[string]any{"current_password": testPassword, "new_password": "a brand new secret"}), 204, "")
	e.want(e.do("GET", "/v1/me", tokA, nil), 200, "")
	e.want(e.do("GET", "/v1/me", tokB, nil), 401, "device_token_invalid")
}

func TestDevicesListRenameRevoke(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("hana@example.com", true)
	b, tokB := e.signin("hana@example.com", true)
	c, tokC := e.signin("hana@example.com", false)
	_, other := e.signup("ivan@example.com", true)

	r := e.do("GET", "/v1/devices", tokA, nil)
	e.want(r, 200, "")
	list := r.body["devices"].([]any)
	if len(list) != 3 {
		t.Fatalf("devices: %s", r.raw)
	}
	first := list[0].(map[string]any)
	if first["id"] != a.Device.ID || first["current"] != true || first["added"] != true || first["has_key"] != false {
		t.Fatalf("current device first: %v", first)
	}
	for _, it := range list[1:] {
		m := it.(map[string]any)
		if m["current"] != false || (m["id"] == c.Device.ID) == (m["added"] == true) {
			t.Fatalf("row %v", m)
		}
	}
	// A not-added device can still see the account list.
	e.want(e.do("GET", "/v1/devices", tokC, nil), 200, "")

	r = e.do("PATCH", "/v1/devices/"+b.Device.ID, tokA, map[string]any{"name": "Kitchen tablet"})
	e.want(r, 200, "")
	if r.str("name") != "Kitchen tablet" || r.str("id") != b.Device.ID {
		t.Fatalf("rename: %s", r.raw)
	}
	e.want(e.do("PATCH", "/v1/devices/"+b.Device.ID, other, map[string]any{"name": "Mine now"}), 404, "not_found")
	e.want(e.do("PATCH", "/v1/devices/"+b.Device.ID, tokA, map[string]any{"name": ""}), 400, "invalid_request")

	e.want(e.do("DELETE", "/v1/devices/"+a.Device.ID, tokA, nil), 409, "use_signout")
	e.want(e.do("DELETE", "/v1/devices/"+b.Device.ID, tokC, nil), 403, "device_not_added")
	e.want(e.do("DELETE", "/v1/devices/"+b.Device.ID, other, nil), 404, "not_found")
	e.want(e.do("DELETE", "/v1/devices/"+b.Device.ID, tokA, nil), 204, "")
	e.want(e.do("DELETE", "/v1/devices/"+b.Device.ID, tokA, nil), 404, "not_found")

	// B keeps its guest identity (file sharing keeps working) but lost the account at once.
	e.want(e.do("GET", "/v1/me", tokB, nil), 401, "device_token_invalid")
	s, err := e.dev.Refresh(ctx, b.Secret)
	if err != nil || s.Account.AccountID != "" {
		t.Fatalf("revoked device refresh: %+v %v", s.Account, err)
	}
	e.want(e.do("GET", "/v1/devices/current", s.AccessToken, nil), 200, "")
	if n := len(e.do("GET", "/v1/devices", tokA, nil).body["devices"].([]any)); n != 2 {
		t.Fatalf("after revoke: %d devices", n)
	}
}

func TestRateLimits(t *testing.T) {
	e := newEnv(t)
	e.signup("jo@example.com", true)
	// Sign-in: 5 attempts per IP + email per 15 minutes.
	ip := "203.0.113.50"
	for i := 0; i < 5; i++ {
		e.want(e.doFrom(ip, "POST", "/v1/auth/signin", e.device().AccessToken, map[string]any{"email": "jo@example.com", "password": "wrong password"}), 401, "invalid_credentials")
	}
	r := e.doFrom(ip, "POST", "/v1/auth/signin", e.device().AccessToken, map[string]any{"email": "jo@example.com", "password": testPassword})
	e.want(r, 429, "rate_limited")
	if r.hdr.Get("Retry-After") == "" {
		t.Fatal("429 needs Retry-After")
	}
	// Another address is not affected; after the window the first one works again.
	e.want(e.doFrom("203.0.113.51", "POST", "/v1/auth/signin", e.device().AccessToken, map[string]any{"email": "jo@example.com", "password": testPassword}), 200, "")
	e.clk.Advance(15 * time.Minute)
	e.want(e.doFrom(ip, "POST", "/v1/auth/signin", e.device().AccessToken, map[string]any{"email": "jo@example.com", "password": testPassword}), 200, "")

	// Sign-in: failed attempts per email from any address (20 / hour).
	for i := 0; i < 20; i++ {
		e.doFrom("198.18.0."+itoa(i), "POST", "/v1/auth/signin", e.device().AccessToken, map[string]any{"email": "jo@example.com", "password": "wrong password"})
	}
	e.want(e.doFrom("198.18.1.1", "POST", "/v1/auth/signin", e.device().AccessToken, map[string]any{"email": "jo@example.com", "password": testPassword}), 429, "rate_limited")

	// Sign-up: 5 per IP per hour.
	ip = "203.0.113.60"
	for i := 0; i < 5; i++ {
		e.want(e.doFrom(ip, "POST", "/v1/auth/signup", e.device().AccessToken, map[string]any{"email": "u" + itoa(i) + "@example.com", "password": testPassword}), 201, "")
	}
	e.want(e.doFrom(ip, "POST", "/v1/auth/signup", e.device().AccessToken, map[string]any{"email": "u9@example.com", "password": testPassword}), 429, "rate_limited")

	// Reset request: 3 per email per hour, 10 per IP per hour.
	for i := 0; i < 3; i++ {
		e.want(e.doFrom("203.0.113.7"+itoa(i), "POST", "/v1/auth/password-reset/request", "", map[string]any{"email": "jo@example.com"}), 202, "")
	}
	e.want(e.doFrom("203.0.113.79", "POST", "/v1/auth/password-reset/request", "", map[string]any{"email": "jo@example.com"}), 429, "rate_limited")
	if e.mail.Count() != 3 {
		t.Fatalf("mails sent: %d", e.mail.Count())
	}
	ip = "203.0.113.80"
	for i := 0; i < 10; i++ {
		e.want(e.doFrom(ip, "POST", "/v1/auth/password-reset/request", "", map[string]any{"email": "r" + itoa(i) + "@example.com"}), 202, "")
	}
	e.want(e.doFrom(ip, "POST", "/v1/auth/password-reset/request", "", map[string]any{"email": "r99@example.com"}), 429, "rate_limited")
}

func itoa(i int) string {
	const digits = "0123456789"
	if i < 10 {
		return digits[i : i+1]
	}
	return itoa(i/10) + digits[i%10:i%10+1]
}
