package auth

import (
	"sync"
	"sync/atomic"
	"testing"
)

// raceSetup builds an account whose rotation is already owed (a keyed device U signed out), with three
// devices A, B and L proven at version 1. QA round 4 P1-1 needs rotation_due to start true.
// lTok is L's guest token (to sign in again after the revoke); lAcct is L's account token.
func (e *env) raceSetup(t *testing.T, email string) (aID, aTok, bTok, lID, lTok, lAcct, userID string) {
	t.Helper()
	da, tokA := e.signup(email, true)
	userID = e.ident(tokA).AccountID
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(da.Device.ID, 1, pub32(1))), 204, "")
	db, tokB := e.signin(email, true)
	e.want(e.do("PUT", "/v1/keys/device", tokB, deviceKeyBody(db.Device.ID, 1, pub32(2))), 204, "")
	dl, tokL := e.signin(email, true)
	e.want(e.do("PUT", "/v1/keys/device", tokL, deviceKeyBody(dl.Device.ID, 1, pub32(3))), 204, "")
	du, tokU := e.signin(email, true)
	e.want(e.do("PUT", "/v1/keys/device", tokU, deviceKeyBody(du.Device.ID, 1, pub32(4))), 204, "")
	e.want(e.do("POST", "/v1/auth/signout", tokU, nil), 200, "")
	if !e.rotationDue(userID) {
		t.Fatal("setup: rotation must be owed after a keyed sign-out")
	}
	return da.Device.ID, tokA, tokB, dl.Device.ID, dl.AccessToken, tokL, userID
}

// TestRevokeRacingOwedRotation (QA round 4 P1-1): A revokes L while B performs the owed rotation that still
// lists L. Whatever the interleaving, L must never be left with a deliverable blob for the new version while
// nothing is owed: either the rotation saw L gone (409 devices_changed, still owed), or the revoke ran after
// it, set rotation_due again and deleted L's blob. A revoked L that signs in again gets no pending keys.
func TestRevokeRacingOwedRotation(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < 40; i++ {
		email := "race" + itoa(i) + "@example.com"
		aID, aTok, bTok, lID, lTok, _, userID := e.raceSetup(t, email)
		body := rotateBody(2, adk(1), 4, map[string]string{aID: blob(92, 5), lID: blob(92, 6)})
		var wg sync.WaitGroup
		var rr, dr resp
		wg.Add(2)
		go func() { defer wg.Done(); rr = e.do("POST", "/v1/keys/rotate", bTok, body) }()
		go func() { defer wg.Done(); dr = e.do("DELETE", "/v1/devices/"+lID, aTok, nil) }()
		wg.Wait()
		if dr.code != 204 {
			t.Fatalf("iteration %d: revoke %d", i, dr.code)
		}
		if rr.code != 200 && rr.code != 409 {
			t.Fatalf("iteration %d: rotate %d %v", i, rr.code, rr.body)
		}
		var left int
		if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM device_key_blobs WHERE device_id = $1::uuid`, lID).Scan(&left); err != nil {
			t.Fatal(err)
		}
		if left != 0 {
			t.Fatalf("iteration %d (rotate %d): %d blob(s) left for the revoked device", i, rr.code, left)
		}
		if !e.rotationDue(userID) {
			t.Fatalf("iteration %d (rotate %d): rotation_due cleared although L left with the current ADK", i, rr.code)
		}
		// L (revoked, knows the password) signs in again on the same device: nothing is pending for it.
		r := e.doFrom(e.ip(), "POST", "/v1/auth/signin", lTok, map[string]any{"email": email, "password": testPassword, "add_device": true})
		if r.code != 200 {
			t.Fatalf("iteration %d: L re-sign-in %d", i, r.code)
		}
		if p := e.do("GET", "/v1/keys", r.str("access_token"), nil); len(p.body["pending"].([]any)) != 0 {
			t.Fatalf("iteration %d: L pending after re-sign-in: %v", i, p.body["pending"])
		}
	}
}

// TestPendingOnlyForRegisteredDevice: a blob stored for a device is not delivered once that device has no
// registered key for the account (it left; defense in depth for any blob left behind).
func TestPendingOnlyForRegisteredDevice(t *testing.T) {
	e := newEnv(t)
	aID, _, bTok, lID, _, lAcct, _ := e.raceSetup(t, "pend@example.com")
	e.want(e.do("POST", "/v1/keys/rotate", bTok, rotateBody(2, adk(1), 4, map[string]string{aID: blob(92, 5), lID: blob(92, 6)})), 200, "")
	if p := e.do("GET", "/v1/keys", lAcct, nil); len(p.body["pending"].([]any)) != 1 {
		t.Fatalf("registered device must see its blob: %v", p.body["pending"])
	}
	// Simulate a leftover blob: drop L's key row but keep the blob.
	if _, err := e.pool.Exec(ctx, `DELETE FROM device_keys WHERE device_id = $1::uuid`, lID); err != nil {
		t.Fatal(err)
	}
	if p := e.do("GET", "/v1/keys", lAcct, nil); len(p.body["pending"].([]any)) != 0 {
		t.Fatalf("a device without a registered key must not get blobs: %v", p.body["pending"])
	}
}

// TestRegisterRacingOwnRevoke (QA round 5 P2-1): a device registering its key while it is being revoked never
// ends up with a key row outside the account: either the registration landed first (the revoke then deletes it
// and sets rotation_due) or it fails because the session is gone.
func TestRegisterRacingOwnRevoke(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < 40; i++ {
		email := "regrace" + itoa(i) + "@example.com"
		da, tokA := e.signup(email, true)
		userID := e.ident(tokA).AccountID
		e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
		e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(da.Device.ID, 1, pub32(1))), 204, "")
		dl, tokL := e.signin(email, true)
		var wg sync.WaitGroup
		var reg, rev resp
		wg.Add(2)
		go func() {
			defer wg.Done()
			reg = e.do("PUT", "/v1/keys/device", tokL, deviceKeyBody(dl.Device.ID, 1, pub32(3)))
		}()
		go func() { defer wg.Done(); rev = e.do("DELETE", "/v1/devices/"+dl.Device.ID, tokA, nil) }()
		wg.Wait()
		if rev.code != 204 {
			t.Fatalf("iteration %d: revoke %d", i, rev.code)
		}
		var rows int
		if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM device_keys WHERE device_id = $1::uuid`, dl.Device.ID).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		if rows != 0 {
			t.Fatalf("iteration %d (register %d): key row left for the revoked device", i, reg.code)
		}
		if reg.code == 204 && !e.rotationDue(userID) {
			t.Fatalf("iteration %d: the registration landed first, so the revoke must leave a rotation owed", i)
		}
		if reg.code != 204 && reg.code != 401 && reg.code != 403 {
			t.Fatalf("iteration %d: register %d %v", i, reg.code, reg.body)
		}
	}
}

// TestEvictedDeviceRotationRace (QA round 6 P1): the owner changes the password to evict L while L keeps
// posting a v2 rotation (refused while B is still in the account). Before the fix a request that had passed
// the session check outside the transaction landed after the eviction committed, created v2 and cleared
// rotation_due. Now every key write holds the account key row and re-checks its session after it: either L's rotation commits before the
// eviction (which then sets rotation_due again) or it is refused because the session is gone.
func TestEvictedDeviceRotationRace(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < 20; i++ {
		email := "evict" + itoa(i) + "@example.com"
		da, tokA := e.signup(email, true)
		userID := e.ident(tokA).AccountID
		e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
		e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(da.Device.ID, 1, pub32(1))), 204, "")
		db, tokB := e.signin(email, true)
		e.want(e.do("PUT", "/v1/keys/device", tokB, deviceKeyBody(db.Device.ID, 1, pub32(2))), 204, "")
		dl, tokL := e.signin(email, true)
		e.want(e.do("PUT", "/v1/keys/device", tokL, deviceKeyBody(dl.Device.ID, 1, pub32(3))), 204, "")
		var stop atomic.Bool
		var accepted atomic.Int32
		var wg sync.WaitGroup
		for g := 0; g < 4; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for !stop.Load() {
					r := e.do("POST", "/v1/keys/rotate", tokL, rotateBody(2, adk(1), 4, map[string]string{da.Device.ID: blob(92, 5)}))
					if r.code == 200 {
						accepted.Add(1)
					}
					if r.code == 401 || (r.code == 409 && r.str("error") == "key_version_conflict") {
						return
					}
				}
			}()
		}
		e.want(e.do("POST", "/v1/me/password", tokA, map[string]any{"current_password": testPassword, "new_password": "a brand new secret"}), 204, "")
		stop.Store(true)
		wg.Wait()
		if accepted.Load() > 0 && !e.rotationDue(userID) {
			t.Fatalf("iteration %d: the evicted device created v2 and nothing is owed", i)
		}
	}
}

// TestRotateNeedsOwnCurrentProof (QA round 6): only a device whose own wrapping key is registered and proven
// at the current version may rotate, even with a validly signed request; a departure of such a device always
// sets rotation_due, so a rotation it made just before leaving is rotated away again.
func TestRotateNeedsOwnCurrentProof(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("proofrot@example.com", true)
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, nil)), 403, "device_key_unproven")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 204, "")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, nil)), 200, "")
	// Its proof (1) is now stale: the next rotation needs a re-proof at 2 first.
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(3, adk(2), 5, nil)), 403, "device_key_unproven")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 2, pub32(1))), 204, "")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(3, adk(2), 5, nil)), 200, "")
}

// TestPairingNotOfferedForDepartedDevice (QA round 7 P2-5): a pairing whose new device is no longer an added
// device of the account (a leftover row) is never offered to, or wrapped by, an existing device.
func TestPairingNotOfferedForDepartedDevice(t *testing.T) {
	e := newEnv(t)
	_, tokA := e.signup("pairgone@example.com", true)
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	n, tokN := e.signin("pairgone@example.com", true)
	r := e.do("POST", "/v1/keys/pairings", tokN, map[string]any{"ephemeral_public_key": key32(7)})
	e.want(r, 201, "")
	code := r.str("code")
	e.want(e.do("GET", "/v1/keys/pairings/by-code/"+code, tokA, nil), 200, "")
	// Simulate a leftover: N's session ends but its pairing row stays.
	if _, err := e.pool.Exec(ctx, `UPDATE auth_sessions SET revoked_at = now() WHERE device_id = $1::uuid`, n.Device.ID); err != nil {
		t.Fatal(err)
	}
	e.want(e.do("GET", "/v1/keys/pairings/by-code/"+code, tokA, nil), 404, "not_found")
	// Nor can it be wrapped.
	wrap := map[string]any{"key_version": 1, "sender_public_key": key32(1), "blob": blob(92, 5)}
	e.want(e.do("POST", "/v1/keys/pairings/by-code/"+code+"/wrap", tokA, wrap), 404, "not_found")
}
