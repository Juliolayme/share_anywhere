package auth

import (
	"sync"
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
