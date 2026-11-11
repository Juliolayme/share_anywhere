package auth

import (
	"bytes"
	"crypto/ed25519"
	"strings"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
)

// Test ADK versions: a real holder of adk(v) can sign as version v (docs/ADR/0012-key-authenticity.md).
func adk(v int) []byte { return bytes.Repeat([]byte{0xa0 + byte(v)}, 32) }

var testRecoverySeed = bytes.Repeat([]byte{0x5e}, 32)

func setupBody() map[string]any {
	_, anchor := recoveryAnchor(testRecoverySeed, verifyKeyOf(adk(1)))
	return map[string]any{
		"recovery_public_key": key32(9), "salt": blob(16, 1),
		"params": map[string]any{"m": 65536, "t": 3, "p": 1}, "recovery_blob": blob(92, 2),
		"verify_key": enc(verifyKeyOf(adk(1))), "recovery_anchor": enc(anchor),
	}
}

// deviceKeyBody registers pub for deviceID with a proof by adk(v).
func deviceKeyBody(deviceID string, v int, pub []byte) map[string]any {
	return deviceKeyBodySigned(deviceID, v, pub, adk(v))
}

func deviceKeyBodySigned(deviceID string, v int, pub, signer []byte) map[string]any {
	return map[string]any{"public_key": enc(pub), "key_version": v,
		"proof": enc(ed25519.Sign(signKey(signer), DeviceKeyMessage(deviceID, v, pub)))}
}

func pub32(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// rotateBody moves to version v (ADK adk(v)), signed by signer (a real rotation passes adk(v-1)).
func rotateBody(v int, signer []byte, chainByte byte, blobs map[string]string) map[string]any {
	list := []map[string]any{}
	for d, bl := range blobs {
		list = append(list, map[string]any{"device_id": d, "blob": bl})
	}
	chain := bytes.Repeat([]byte{chainByte}, 60)
	vk := verifyKeyOf(adk(v))
	return map[string]any{
		"key_version": v, "recovery_blob": blob(92, 3), "chain_blob": enc(chain), "device_blobs": list,
		"verify_key": enc(vk), "signature": enc(ed25519.Sign(signKey(signer), RotationMessage(v, vk, chain))),
	}
}

func TestKeysSetupRotateAndConflicts(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("kim@example.com", true)
	b, tokB := e.signin("kim@example.com", true)
	c, tokC := e.signin("kim@example.com", true) // added, never registers a key

	r := e.do("GET", "/v1/keys", tokA, nil)
	e.want(r, 200, "")
	if r.body["key_version"].(float64) != 0 || r.body["recovery"] != nil || len(r.body["devices"].([]any)) != 3 {
		t.Fatalf("empty keys: %s", r.raw)
	}
	e.want(e.do("POST", "/v1/keys/setup", tokA, map[string]any{"recovery_public_key": key32(9)[:10], "salt": blob(16, 1),
		"params": map[string]any{"m": 65536, "t": 3, "p": 1}, "recovery_blob": blob(92, 2)}), 400, "invalid_request")
	// verify_key and recovery_anchor are required, 32 bytes each.
	for _, field := range []string{"verify_key", "recovery_anchor"} {
		b := setupBody()
		delete(b, field)
		e.want(e.do("POST", "/v1/keys/setup", tokA, b), 400, "invalid_request")
		b[field] = blob(31, 1)
		e.want(e.do("POST", "/v1/keys/setup", tokA, b), 400, "invalid_request")
	}
	e.want(e.do("GET", "/v1/keys/recovery", tokA, nil), 404, "not_found")
	r = e.do("POST", "/v1/keys/setup", tokA, setupBody())
	e.want(r, 201, "")
	if r.body["key_version"].(float64) != 1 {
		t.Fatalf("setup: %s", r.raw)
	}
	e.want(e.do("POST", "/v1/keys/setup", tokB, setupBody()), 409, "keys_exist")

	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 204, "")
	e.want(e.do("PUT", "/v1/keys/device", tokB, deviceKeyBody(b.Device.ID, 1, pub32(2))), 204, "")
	bad := deviceKeyBody(b.Device.ID, 1, pub32(2))
	bad["public_key"] = enc(make([]byte, 31))
	e.want(e.do("PUT", "/v1/keys/device", tokB, bad), 400, "invalid_request")

	r = e.do("GET", "/v1/keys", tokB, nil)
	rec := r.body["recovery"].(map[string]any)
	if rec["public_key"] != key32(9) || rec["salt"] != blob(16, 1) || rec["params"].(map[string]any)["m"].(float64) != 65536 {
		t.Fatalf("recovery: %s", r.raw)
	}
	keys := map[string]map[string]any{}
	for _, d := range r.body["devices"].([]any) {
		m := d.(map[string]any)
		keys[m["device_id"].(string)] = m
	}
	if keys[a.Device.ID]["public_key"] != key32(1) || keys[b.Device.ID]["public_key"] != key32(2) || keys[c.Device.ID]["public_key"] != nil {
		t.Fatalf("device keys: %v", keys)
	}
	// Each registered key carries its version and proof (so another device can check it); unregistered: nulls.
	if keys[b.Device.ID]["key_version"].(float64) != 1 || keys[b.Device.ID]["proof"] != deviceKeyBody(b.Device.ID, 1, pub32(2))["proof"] ||
		keys[c.Device.ID]["key_version"] != nil || keys[c.Device.ID]["proof"] != nil {
		t.Fatalf("device key proofs: %v", keys)
	}
	_, anchor := recoveryAnchor(testRecoverySeed, verifyKeyOf(adk(1)))
	r = e.do("GET", "/v1/keys/recovery", tokC, nil)
	if r.code != 200 || r.body["key_version"].(float64) != 1 || r.str("recovery_blob") != blob(92, 2) || r.str("recovery_anchor") != enc(anchor) {
		t.Fatalf("recovery blob: %s", r.raw)
	}

	rotate := func(tok string, v int, blobs map[string]string) resp {
		return e.do("POST", "/v1/keys/rotate", tok, rotateBody(v, adk(v-1), 4, blobs))
	}
	// Wrong version.
	e.want(rotate(tokA, 3, map[string]string{b.Device.ID: blob(92, 5)}), 409, "key_version_conflict")
	e.want(rotate(tokA, 1, map[string]string{b.Device.ID: blob(92, 5)}), 409, "key_version_conflict")
	// B has a registered key and no blob (C has no key, so it is not required).
	r = rotate(tokA, 2, map[string]string{})
	e.want(r, 409, "devices_changed")
	if m, u := r.body["missing"].([]any), r.body["unexpected"].([]any); len(m) != 1 || m[0] != b.Device.ID || len(u) != 0 {
		t.Fatalf("missing: %s", r.raw)
	}
	// A blob for a device outside the account, or for an added device without a registered key (C), is
	// refused with both lists and nothing is stored.
	_, outsider := e.signup("lee@example.com", true)
	outsiderID := e.ident(outsider).DeviceID
	r = rotate(tokA, 2, map[string]string{b.Device.ID: blob(92, 5), outsiderID: blob(92, 6)})
	e.want(r, 409, "devices_changed")
	if m, u := r.body["missing"].([]any), r.body["unexpected"].([]any); len(m) != 0 || len(u) != 1 || u[0] != outsiderID {
		t.Fatalf("unexpected: %s", r.raw)
	}
	r = rotate(tokA, 2, map[string]string{c.Device.ID: blob(92, 6)})
	e.want(r, 409, "devices_changed")
	if m, u := r.body["missing"].([]any), r.body["unexpected"].([]any); len(m) != 1 || m[0] != b.Device.ID || len(u) != 1 || u[0] != c.Device.ID {
		t.Fatalf("missing and unexpected: %s", r.raw)
	}
	// The caller may include a safety copy for itself; it lands in its own pending list.
	r = rotate(tokA, 2, map[string]string{b.Device.ID: blob(92, 5), a.Device.ID: blob(92, 9)})
	e.want(r, 200, "")
	selfPending := e.do("GET", "/v1/keys", tokA, nil).body["pending"].([]any)
	if len(selfPending) != 1 || selfPending[0].(map[string]any)["blob"] != blob(92, 9) {
		t.Fatalf("caller's safety copy: %v", selfPending)
	}
	if r.body["key_version"].(float64) != 2 {
		t.Fatalf("rotate: %s", r.raw)
	}
	// Concurrent rotation by another device on the old version conflicts.
	e.want(rotate(tokB, 2, map[string]string{a.Device.ID: blob(92, 7)}), 409, "key_version_conflict")

	r = e.do("GET", "/v1/keys", tokB, nil)
	pending := r.body["pending"].([]any)
	if r.body["key_version"].(float64) != 2 || len(pending) != 1 {
		t.Fatalf("pending: %s", r.raw)
	}
	p := pending[0].(map[string]any)
	if p["key_version"].(float64) != 2 || p["blob"] != blob(92, 5) || p["from_device_id"] != a.Device.ID {
		t.Fatalf("pending blob: %v", p)
	}
	e.want(e.do("DELETE", "/v1/keys/pending/2", tokB, nil), 204, "")
	e.want(e.do("DELETE", "/v1/keys/pending/2", tokB, nil), 204, "")
	if n := len(e.do("GET", "/v1/keys", tokB, nil).body["pending"].([]any)); n != 0 {
		t.Fatal("ack must remove the blob")
	}
	r = e.do("GET", "/v1/keys/chain", tokC, nil)
	chain := r.body["chain"].([]any)
	if len(chain) != 1 || chain[0].(map[string]any)["key_version"].(float64) != 2 || chain[0].(map[string]any)["blob"] != blob(60, 4) {
		t.Fatalf("chain: %s", r.raw)
	}
	// versions lists 1..current with verify keys and the signature that authorized each rotation.
	versions := r.body["versions"].([]any)
	v1, v2 := versions[0].(map[string]any), versions[1].(map[string]any)
	if len(versions) != 2 || v1["key_version"].(float64) != 1 || v1["verify_key"] != enc(verifyKeyOf(adk(1))) || v1["signature"] != nil ||
		v2["key_version"].(float64) != 2 || v2["verify_key"] != enc(verifyKeyOf(adk(2))) || v2["signature"] != rotateBody(2, adk(1), 4, nil)["signature"] {
		t.Fatalf("versions: %s", r.raw)
	}
	if r := e.do("GET", "/v1/keys/recovery", tokA, nil); r.body["key_version"].(float64) != 2 || r.str("recovery_blob") != blob(92, 3) {
		t.Fatalf("recovery after rotation: %s", r.raw)
	}
	// Blob size limits.
	e.want(rotate(tokA, 3, map[string]string{b.Device.ID: blob(4097, 1)}), 400, "invalid_request")
}

// TestRevokedDeviceCannotReadHistoryOrKeys: after revocation the device's unexpired access token stops
// working at once, its refresh yields a guest token, and rotation no longer needs (or accepts) a blob for it.
func TestRevokedDeviceCannotReadHistoryOrKeys(t *testing.T) {
	e := newEnv(t)
	_, tokA := e.signup("max@example.com", true)
	b, tokB := e.signin("max@example.com", true)
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	e.want(e.do("PUT", "/v1/keys/device", tokB, deviceKeyBody(b.Device.ID, 1, pub32(2))), 204, "")
	e.want(e.do("POST", "/v1/history/entries", tokA, entryBody(newID(), 1)), 201, "")
	e.want(e.do("GET", "/v1/history/entries", tokB, nil), 200, "")

	e.want(e.do("DELETE", "/v1/devices/"+b.Device.ID, tokA, nil), 204, "")
	e.want(e.do("POST", "/v1/history/entries", tokA, entryBody(newID(), 1)), 201, "")

	e.want(e.do("GET", "/v1/history/entries", tokB, nil), 401, "device_token_invalid")
	e.want(e.do("GET", "/v1/keys", tokB, nil), 401, "device_token_invalid")
	e.want(e.do("GET", "/v1/keys/recovery", tokB, nil), 401, "device_token_invalid")
	// Service level, bypassing the token cache: the stale identity is refused too.
	if _, err := e.svc.Entries(ctx, e.identUnchecked(tokB), 0, 10); err != ErrTokenStale {
		t.Fatalf("stale identity: %v", err)
	}
	s, err := e.dev.Refresh(ctx, b.Secret)
	if err != nil {
		t.Fatal(err)
	}
	e.want(e.do("GET", "/v1/history/entries", s.AccessToken, nil), 403, "account_required")
	// Its wrapping key is gone, so rotation needs no blob for it and refuses one.
	r := e.do("GET", "/v1/keys", tokA, nil)
	if len(r.body["devices"].([]any)) != 1 {
		t.Fatalf("devices after revoke: %s", r.raw)
	}
	r = e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, map[string]string{b.Device.ID: blob(92, 5)}))
	e.want(r, 409, "devices_changed")
	if u := r.body["unexpected"].([]any); len(u) != 1 || u[0] != b.Device.ID {
		t.Fatalf("unexpected after revoke: %s", r.raw)
	}
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, nil)), 200, "")
}

func TestPairingOneTimePickupAndExpiry(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("nia@example.com", true)
	c, tokC := e.signin("nia@example.com", true)
	_, notAdded := e.signin("nia@example.com", false)
	_, stranger := e.signup("oz@example.com", true)
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")

	e.want(e.do("POST", "/v1/keys/pairings", tokC, map[string]any{"ephemeral_public_key": "short"}), 400, "invalid_request")
	e.want(e.do("POST", "/v1/keys/pairings", notAdded, map[string]any{"ephemeral_public_key": key32(7)}), 403, "device_not_added")
	r := e.do("POST", "/v1/keys/pairings", tokC, map[string]any{"ephemeral_public_key": key32(7)})
	e.want(r, 201, "")
	code, pid := r.str("code"), r.str("pairing_id")
	if b, ok := b64(code); !ok || len(b) < 16 {
		t.Fatalf("code must carry at least 128 bits: %q", code)
	}
	exp, _ := time.Parse(time.RFC3339, r.str("expires_at"))
	if !exp.Equal(t0.Add(PairingTTL)) {
		t.Fatalf("expires_at %v", exp)
	}

	e.want(e.do("GET", "/v1/keys/pairings/by-code/"+code, tokC, nil), 404, "not_found")     // own code
	e.want(e.do("GET", "/v1/keys/pairings/by-code/"+code, stranger, nil), 404, "not_found") // other account
	e.want(e.do("GET", "/v1/keys/pairings/by-code/nope", tokA, nil), 404, "not_found")
	r = e.do("GET", "/v1/keys/pairings/by-code/"+code, tokA, nil)
	e.want(r, 200, "")
	if r.str("pairing_id") != pid || r.str("ephemeral_public_key") != key32(7) || r.str("device_id") != c.Device.ID || r.str("device_name") == "" {
		t.Fatalf("lookup: %s", r.raw)
	}
	if s := e.do("GET", "/v1/keys/pairings/"+pid, tokC, nil); s.str("status") != "waiting" || s.body["blob"] != nil {
		t.Fatalf("waiting: %s", s.raw)
	}
	e.want(e.do("GET", "/v1/keys/pairings/"+pid, tokA, nil), 404, "not_found") // not the owner

	wrap := map[string]any{"key_version": 1, "sender_public_key": key32(1), "blob": blob(92, 8)}
	// The sender key must be the wrapping device's registered (proven) key.
	e.want(e.do("POST", "/v1/keys/pairings/by-code/"+code+"/wrap", tokA, wrap), 403, "device_key_unproven")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 204, "")
	e.want(e.do("POST", "/v1/keys/pairings/by-code/"+code+"/wrap", tokA, map[string]any{"key_version": 1, "sender_public_key": key32(3), "blob": blob(92, 8)}), 403, "device_key_unproven")
	e.want(e.do("POST", "/v1/keys/pairings/by-code/"+code+"/wrap", tokA, map[string]any{"key_version": 2, "sender_public_key": key32(1), "blob": blob(92, 8)}), 409, "key_version_conflict")
	e.want(e.do("POST", "/v1/keys/pairings/by-code/"+code+"/wrap", stranger, wrap), 404, "not_found")
	e.want(e.do("POST", "/v1/keys/pairings/by-code/"+code+"/wrap", tokA, wrap), 204, "")
	e.want(e.do("POST", "/v1/keys/pairings/by-code/"+code+"/wrap", tokA, wrap), 404, "not_found") // once
	e.want(e.do("GET", "/v1/keys/pairings/by-code/"+code, tokA, nil), 404, "not_found")

	s := e.do("GET", "/v1/keys/pairings/"+pid, tokC, nil)
	if s.str("status") != "ready" || s.str("blob") != blob(92, 8) || s.str("sender_public_key") != key32(1) || s.body["key_version"].(float64) != 1 {
		t.Fatalf("ready: %s", s.raw)
	}
	if s := e.do("GET", "/v1/keys/pairings/"+pid, tokC, nil); s.str("status") != "expired" || s.body["blob"] != nil {
		t.Fatalf("blob must be returned once: %s", s.raw)
	}
	var left []byte
	_ = e.pool.QueryRow(ctx, `SELECT blob FROM device_pairings WHERE id = $1::uuid`, pid).Scan(&left)
	if left != nil {
		t.Fatal("picked-up blob must be deleted")
	}

	// Expiry: a new pairing replaces the old one and ends after 10 minutes.
	r = e.do("POST", "/v1/keys/pairings", tokC, map[string]any{"ephemeral_public_key": key32(6)})
	e.want(r, 201, "")
	code2, pid2 := r.str("code"), r.str("pairing_id")
	e.want(e.do("GET", "/v1/keys/pairings/"+pid, tokC, nil), 404, "not_found") // replaced
	e.clk.Advance(PairingTTL + time.Second)
	e.want(e.do("GET", "/v1/keys/pairings/by-code/"+code2, tokA, nil), 404, "not_found")
	e.want(e.do("POST", "/v1/keys/pairings/by-code/"+code2+"/wrap", tokA, wrap), 404, "not_found")
	if s := e.do("GET", "/v1/keys/pairings/"+pid2, tokC, nil); s.str("status") != "expired" {
		t.Fatalf("expired: %s", s.raw)
	}
}

func TestPairingRateLimit(t *testing.T) {
	e := newEnv(t)
	_, tok := e.signup("pat@example.com", true)
	for i := 0; i < 10; i++ {
		e.want(e.do("POST", "/v1/keys/pairings", tok, map[string]any{"ephemeral_public_key": key32(byte(i))}), 201, "")
	}
	e.want(e.do("POST", "/v1/keys/pairings", tok, map[string]any{"ephemeral_public_key": key32(1)}), 429, "rate_limited")
	for i := 0; i < 30; i++ {
		e.do("GET", "/v1/keys/pairings/by-code/x"+itoa(i), tok, nil)
	}
	e.want(e.do("GET", "/v1/keys/pairings/by-code/y", tok, nil), 429, "rate_limited")
}

// TestPasswordOnlyDeviceCannotRotate is the QA P0-1 attack: a device that only knows the password signs in,
// adds itself, and posts a rotation to an ADK of its own choosing. Without ADK(v) it cannot produce the
// version-v signature, so the server refuses it and stores nothing; a real ADK(v) holder rotates fine.
func TestPasswordOnlyDeviceCannotRotate(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("quinn@example.com", true)
	b, tokB := e.signin("quinn@example.com", true)
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 204, "")
	attacker, tokX := e.signin("quinn@example.com", true) // knows the password only

	stored := func() (int, int, int) {
		var v, versions, blobs int
		_ = e.pool.QueryRow(ctx, `SELECT key_version FROM account_keys`).Scan(&v)
		_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM account_key_versions`).Scan(&versions)
		_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM device_key_blobs`).Scan(&blobs)
		return v, versions, blobs
	}
	chosen := bytes.Repeat([]byte{0x66}, 32) // the attacker's own ADK
	blobs := map[string]string{a.Device.ID: blob(92, 5)}
	for name, body := range map[string]map[string]any{
		"self-signed with the chosen ADK": rotateBody(2, chosen, 4, blobs),
		"signed by the new version":       rotateBody(2, adk(2), 4, blobs),
		"garbage signature":               func() map[string]any { m := rotateBody(2, adk(1), 4, blobs); m["signature"] = blob(64, 7); return m }(),
		"signature over another chain": func() map[string]any {
			m := rotateBody(2, adk(1), 4, blobs)
			m["chain_blob"] = blob(60, 9)
			return m
		}(),
	} {
		r := e.do("POST", "/v1/keys/rotate", tokX, body)
		if r.code != 403 || r.str("error") != "rotation_unauthorized" {
			t.Fatalf("%s: got %d %s, want 403 rotation_unauthorized", name, r.code, r.raw)
		}
	}
	if v, versions, nb := stored(); v != 1 || versions != 1 || nb != 0 {
		t.Fatalf("a refused rotation must store nothing: version %d, %d versions, %d blobs", v, versions, nb)
	}
	// It cannot register a wrapping key either, so no rotation ever wraps a key to it.
	e.want(e.do("PUT", "/v1/keys/device", tokX, deviceKeyBodySigned(attacker.Device.ID, 1, pub32(6), chosen)), 403, "device_key_unproven")
	// Malformed signature or verify key is 400.
	m := rotateBody(2, adk(1), 4, blobs)
	m["signature"] = blob(63, 1)
	e.want(e.do("POST", "/v1/keys/rotate", tokX, m), 400, "invalid_request")
	m = rotateBody(2, adk(1), 4, blobs)
	delete(m, "verify_key")
	e.want(e.do("POST", "/v1/keys/rotate", tokX, m), 400, "invalid_request")

	// A real holder of ADK(1) rotates (from any added device, here B), and the next rotation must be signed
	// by version 2: a version-1 signature is now the wrong version.
	e.want(e.do("POST", "/v1/keys/rotate", tokB, rotateBody(2, adk(1), 4, blobs)), 200, "")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(3, adk(1), 5, nil)), 403, "rotation_unauthorized")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(3, adk(2), 5, nil)), 200, "")
	if v, versions, _ := stored(); v != 3 || versions != 3 {
		t.Fatalf("after two real rotations: version %d, %d versions", v, versions)
	}
	_ = b
}

// TestDeviceKeyProof: a wrapping key registers only with a proof by an ADK version the account has, over
// the caller's own device ID (from the token), the stated version, and the key.
func TestDeviceKeyProof(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("rae@example.com", true)
	b, _ := e.signin("rae@example.com", true)
	// No ADK yet: nothing can be proven.
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 403, "device_key_unproven")
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")

	for name, body := range map[string]map[string]any{
		"another device's ID in the message": deviceKeyBody(b.Device.ID, 1, pub32(1)),
		"signed by another version's key":    deviceKeyBodySigned(a.Device.ID, 1, pub32(1), adk(2)),
		"proof for another public key": func() map[string]any {
			m := deviceKeyBody(a.Device.ID, 1, pub32(2))
			m["public_key"] = enc(pub32(1))
			return m
		}(),
		"garbage proof": func() map[string]any {
			m := deviceKeyBody(a.Device.ID, 1, pub32(1))
			m["proof"] = blob(64, 3)
			return m
		}(),
	} {
		r := e.do("PUT", "/v1/keys/device", tokA, body)
		if r.code != 403 || r.str("error") != "device_key_unproven" {
			t.Fatalf("%s: got %d %s, want 403 device_key_unproven", name, r.code, r.raw)
		}
	}
	for name, body := range map[string]map[string]any{
		"short proof": func() map[string]any {
			m := deviceKeyBody(a.Device.ID, 1, pub32(1))
			m["proof"] = blob(10, 3)
			return m
		}(),
		"no key_version": func() map[string]any {
			m := deviceKeyBody(a.Device.ID, 1, pub32(1))
			delete(m, "key_version")
			return m
		}(),
		"version zero":     deviceKeyBody(a.Device.ID, 0, pub32(1)),
		"proof not base64": func() map[string]any { m := deviceKeyBody(a.Device.ID, 1, pub32(1)); m["proof"] = "!!"; return m }(),
	} {
		r := e.do("PUT", "/v1/keys/device", tokA, body)
		if r.code != 400 || r.str("error") != "invalid_request" {
			t.Fatalf("%s: got %d %s, want 400 invalid_request", name, r.code, r.raw)
		}
	}
	var n int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM device_keys`).Scan(&n)
	if n != 0 {
		t.Fatalf("refused registrations stored %d keys", n)
	}
	// A version other than the current one is a version conflict, even with a valid proof.
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 2, pub32(1))), 409, "key_version_conflict")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 204, "")
	// After a rotation only a proof by the new current version is accepted (docs/ADR/0014); the stored
	// registration is unchanged by the refused one.
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, nil)), 200, "")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(9))), 409, "key_version_conflict")
	var stale []byte
	_ = e.pool.QueryRow(ctx, `SELECT public_key FROM device_keys WHERE device_id = $1::uuid`, a.Device.ID).Scan(&stale)
	if !bytes.Equal(stale, pub32(1)) {
		t.Fatal("a refused registration must store nothing")
	}
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 2, pub32(1))), 204, "")
	var kv int
	_ = e.pool.QueryRow(ctx, `SELECT key_version FROM device_keys WHERE device_id = $1::uuid`, a.Device.ID).Scan(&kv)
	if kv != 2 {
		t.Fatalf("stored key_version %d", kv)
	}
}

// TestLegacyKeysRefused: an account whose keys predate migration 0007 (no verify keys, no anchor) cannot
// rotate or register a device key (409 keys_legacy) and reads nulls where the new fields would be.
func TestLegacyKeysRefused(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("sol@example.com", true)
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	if _, err := e.pool.Exec(ctx, `UPDATE account_key_versions SET verify_key = NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `UPDATE account_keys SET recovery_anchor = NULL`); err != nil {
		t.Fatal(err)
	}
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, nil)), 409, "keys_legacy")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 409, "keys_legacy")
	r := e.do("GET", "/v1/keys/recovery", tokA, nil)
	if _, ok := r.body["recovery_anchor"]; r.code != 200 || !ok || r.body["recovery_anchor"] != nil {
		t.Fatalf("legacy recovery: %s", r.raw)
	}
	r = e.do("GET", "/v1/keys/chain", tokA, nil)
	vs := r.body["versions"].([]any)
	if len(vs) != 1 || vs[0].(map[string]any)["verify_key"] != nil || len(r.body["chain"].([]any)) != 0 {
		t.Fatalf("legacy chain: %s", r.raw)
	}
}

// pendingVersions lists the key versions in the pending list of the device with token tok.
func (e *env) pendingVersions(tok string) []float64 {
	e.t.Helper()
	r := e.do("GET", "/v1/keys", tok, nil)
	e.want(r, 200, "")
	out := []float64{}
	for _, p := range r.body["pending"].([]any) {
		out = append(out, p.(map[string]any)["key_version"].(float64))
	}
	return out
}

// TestStaleProofCannotReenter is the QA round 2 P1-A attack (docs/ADR/0014-current-version-proofs.md): a
// laptop L that held ADK(1) is revoked and A rotates to 2. A thief with L's ADK(1) and the password signs in
// on a new device X and adds it. X's proof by version 1 is refused (409 key_version_conflict, nothing
// stored), so A's next rotation neither needs nor accepts a blob for X, and X never receives ADK(3). A device
// proven at the current version does get the next blob; one whose proof is older gets nothing.
func TestStaleProofCannotReenter(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("uma@example.com", true)
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 204, "")
	l, tokL := e.signin("uma@example.com", true)
	e.want(e.do("PUT", "/v1/keys/device", tokL, deviceKeyBody(l.Device.ID, 1, pub32(2))), 204, "")

	e.want(e.do("DELETE", "/v1/devices/"+l.Device.ID, tokA, nil), 204, "")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, map[string]string{a.Device.ID: blob(92, 5)})), 200, "")

	x, tokX := e.signin("uma@example.com", true)
	r := e.do("PUT", "/v1/keys/device", tokX, deviceKeyBody(x.Device.ID, 1, pub32(6)))
	e.want(r, 409, "key_version_conflict")
	var n int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM device_keys WHERE device_id = $1::uuid`, x.Device.ID).Scan(&n)
	if n != 0 {
		t.Fatal("an old-version proof must store nothing")
	}
	// A version-2 claim signed with the ADK(1) it holds does not verify.
	e.want(e.do("PUT", "/v1/keys/device", tokX, deviceKeyBodySigned(x.Device.ID, 2, pub32(6), adk(1))), 403, "device_key_unproven")

	// A's rotation to 3 succeeds without X; a blob for X is refused as unexpected.
	r = e.do("POST", "/v1/keys/rotate", tokA, rotateBody(3, adk(2), 5, map[string]string{x.Device.ID: blob(92, 7)}))
	e.want(r, 409, "devices_changed")
	if m, u := r.body["missing"].([]any), r.body["unexpected"].([]any); len(m) != 0 || len(u) != 1 || u[0] != x.Device.ID {
		t.Fatalf("blob for X: %s", r.raw)
	}
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(3, adk(2), 5, nil)), 200, "")
	if p := e.pendingVersions(tokX); len(p) != 0 {
		t.Fatalf("X must receive nothing: %v", p)
	}

	// B proves version 3 (the current one): the rotation to 4 must include it, and B gets the blob.
	b, tokB := e.signin("uma@example.com", true)
	e.want(e.do("PUT", "/v1/keys/device", tokB, deviceKeyBody(b.Device.ID, 3, pub32(3))), 204, "")
	r = e.do("POST", "/v1/keys/rotate", tokA, rotateBody(4, adk(3), 6, nil))
	e.want(r, 409, "devices_changed")
	if m, u := r.body["missing"].([]any), r.body["unexpected"].([]any); len(m) != 1 || m[0] != b.Device.ID || len(u) != 0 {
		t.Fatalf("B missing: %s", r.raw)
	}
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(4, adk(3), 6, map[string]string{b.Device.ID: blob(92, 8)})), 200, "")
	if p := e.pendingVersions(tokB); len(p) != 1 || p[0] != 4 {
		t.Fatalf("B pending: %v", p)
	}
	// B has not re-proven at 4: its proof (3) is stale, so the rotation to 5 neither needs nor accepts a
	// blob for it (it must pair again); after B proves 4 it is required again.
	r = e.do("POST", "/v1/keys/rotate", tokA, rotateBody(5, adk(4), 7, map[string]string{b.Device.ID: blob(92, 9)}))
	e.want(r, 409, "devices_changed")
	if u := r.body["unexpected"].([]any); len(u) != 1 || u[0] != b.Device.ID {
		t.Fatalf("stale proof blob: %s", r.raw)
	}
	e.want(e.do("PUT", "/v1/keys/device", tokB, deviceKeyBody(b.Device.ID, 4, pub32(3))), 204, "")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(5, adk(4), 7, nil)), 409, "devices_changed")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(5, adk(4), 7, map[string]string{b.Device.ID: blob(92, 9)})), 200, "")
}

func (e *env) rotationDue(userID string) bool {
	e.t.Helper()
	var due bool
	if err := e.pool.QueryRow(ctx, `SELECT rotation_due FROM account_keys WHERE user_id = $1::uuid`, userID).Scan(&due); err != nil {
		e.t.Fatal(err)
	}
	return due
}

// TestRotationDueAfterAnyDeparture (QA round 2 P2-1): whenever an added device with a registered wrapping
// key leaves the account, by any path, rotation_due is set in the same transaction; GET /v1/keys reports it,
// a successful rotation clears it, and a device that never registered a key does not set it.
func TestRotationDueAfterAnyDeparture(t *testing.T) {
	e := newEnv(t)
	cases := []struct {
		name string
		// leave makes B leave the account; A stays unless allGone.
		leave   func(email, tokA, tokB string, b devices.Session)
		allGone bool
	}{
		{name: "revoke from Devices", leave: func(_, tokA, _ string, b devices.Session) {
			e.want(e.do("DELETE", "/v1/devices/"+b.Device.ID, tokA, nil), 204, "")
		}},
		{name: "sign-out", leave: func(_, _, tokB string, _ devices.Session) {
			e.want(e.do("POST", "/v1/auth/signout", tokB, nil), 200, "")
		}},
		{name: "password change on another device", leave: func(_, tokA, _ string, _ devices.Session) {
			e.want(e.do("POST", "/v1/me/password", tokA, map[string]any{"current_password": testPassword, "new_password": "a brand new secret"}), 204, "")
		}},
		{name: "identity reset", leave: func(_, _, tokB string, _ devices.Session) {
			e.want(e.do("POST", "/v1/devices/current/reset", tokB, nil), 201, "")
		}},
		{name: "refresh-secret reuse", leave: func(_, _, _ string, b devices.Session) {
			if _, err := e.dev.Refresh(ctx, b.Secret); err != nil {
				t.Fatal(err)
			}
			e.clk.Advance(time.Minute) // past the reuse grace
			if _, err := e.dev.Refresh(ctx, b.Secret); err == nil {
				t.Fatal("reuse must be refused")
			}
		}},
		{name: "expiry sweep", leave: func(_, _, _ string, b devices.Session) {
			if _, err := e.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at = $2 WHERE device_id = $1::uuid`, b.Device.ID, e.clk.Now().Add(-time.Second)); err != nil {
				t.Fatal(err)
			}
			if err := e.svc.Sweep(ctx); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "password reset", allGone: true, leave: func(email, _, _ string, _ devices.Session) {
			e.want(e.doFrom(e.ip(), "POST", "/v1/auth/password-reset/request", "", map[string]any{"email": email}), 202, "")
			msg, ok := e.mail.Last(email)
			if !ok {
				t.Fatal("no reset mail")
			}
			token := strings.TrimPrefix(msg.Link, "https://app.example/reset?token=")
			e.want(e.do("POST", "/v1/auth/password-reset/confirm", "", map[string]any{"token": token, "password": "a brand new secret"}), 204, "")
		}},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			email := "due" + itoa(i) + "@example.com"
			a, tokA := e.signup(email, true)
			userID := e.ident(tokA).AccountID
			e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
			e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 204, "")
			// A device without a registered key leaving does not make a rotation due.
			c0, _ := e.signin(email, true)
			e.want(e.do("DELETE", "/v1/devices/"+c0.Device.ID, tokA, nil), 204, "")
			if r := e.do("GET", "/v1/keys", tokA, nil); r.body["rotation_due"] != false {
				t.Fatalf("no key, no rotation due: %s", r.raw)
			}
			b, tokB := e.signin(email, true)
			e.want(e.do("PUT", "/v1/keys/device", tokB, deviceKeyBody(b.Device.ID, 1, pub32(2))), 204, "")

			c.leave(email, tokA, tokB, b)

			if !e.rotationDue(userID) {
				t.Fatal("rotation_due must be set")
			}
			if c.allGone {
				return
			}
			r := e.do("GET", "/v1/keys", tokA, nil)
			if r.body["rotation_due"] != true || len(r.body["devices"].([]any)) != 1 {
				t.Fatalf("keys after departure: %s", r.raw)
			}
			// A refused rotation leaves it set; a successful one clears it.
			e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, map[string]string{b.Device.ID: blob(92, 5)})), 409, "devices_changed")
			if !e.rotationDue(userID) {
				t.Fatal("a refused rotation must not clear rotation_due")
			}
			e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, nil)), 200, "")
			if r := e.do("GET", "/v1/keys", tokA, nil); r.body["rotation_due"] != false {
				t.Fatalf("rotation must clear rotation_due: %s", r.raw)
			}
		})
	}
}

// TestKeysStateShape pins the GET /v1/keys body: every documented field is present, including
// rotation_due (false for a new account) and the nullable per-device proof fields.
func TestKeysStateShape(t *testing.T) {
	e := newEnv(t)
	_, tok := e.signup("vic@example.com", true)
	r := e.do("GET", "/v1/keys", tok, nil)
	e.want(r, 200, "")
	for _, k := range []string{"key_version", "recovery", "devices", "pending", "rotation_due"} {
		if _, ok := r.body[k]; !ok {
			t.Fatalf("GET /v1/keys lacks %s: %s", k, r.raw)
		}
	}
	if len(r.body) != 5 || r.body["rotation_due"] != false || r.body["key_version"].(float64) != 0 {
		t.Fatalf("GET /v1/keys: %s", r.raw)
	}
	d := r.body["devices"].([]any)[0].(map[string]any)
	for _, k := range []string{"device_id", "public_key", "key_version", "proof"} {
		if _, ok := d[k]; !ok || len(d) != 4 {
			t.Fatalf("device key item: %v", d)
		}
	}
}
