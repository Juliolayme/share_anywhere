package auth

import (
	"testing"
	"time"
)

func setupBody() map[string]any {
	return map[string]any{
		"recovery_public_key": key32(9), "salt": blob(16, 1),
		"params": map[string]any{"m": 65536, "t": 3, "p": 1}, "recovery_blob": blob(92, 2),
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
	e.want(e.do("GET", "/v1/keys/recovery", tokA, nil), 404, "not_found")
	r = e.do("POST", "/v1/keys/setup", tokA, setupBody())
	e.want(r, 201, "")
	if r.body["key_version"].(float64) != 1 {
		t.Fatalf("setup: %s", r.raw)
	}
	e.want(e.do("POST", "/v1/keys/setup", tokB, setupBody()), 409, "keys_exist")

	e.want(e.do("PUT", "/v1/keys/device", tokA, map[string]any{"public_key": key32(1)}), 204, "")
	e.want(e.do("PUT", "/v1/keys/device", tokB, map[string]any{"public_key": key32(2)}), 204, "")
	e.want(e.do("PUT", "/v1/keys/device", tokB, map[string]any{"public_key": enc(make([]byte, 31))}), 400, "invalid_request")

	r = e.do("GET", "/v1/keys", tokB, nil)
	rec := r.body["recovery"].(map[string]any)
	if rec["public_key"] != key32(9) || rec["salt"] != blob(16, 1) || rec["params"].(map[string]any)["m"].(float64) != 65536 {
		t.Fatalf("recovery: %s", r.raw)
	}
	keys := map[string]any{}
	for _, d := range r.body["devices"].([]any) {
		m := d.(map[string]any)
		keys[m["device_id"].(string)] = m["public_key"]
	}
	if keys[a.Device.ID] != key32(1) || keys[b.Device.ID] != key32(2) || keys[c.Device.ID] != nil {
		t.Fatalf("device keys: %v", keys)
	}
	r = e.do("GET", "/v1/keys/recovery", tokC, nil)
	if r.code != 200 || r.body["key_version"].(float64) != 1 || r.str("recovery_blob") != blob(92, 2) {
		t.Fatalf("recovery blob: %s", r.raw)
	}

	rotate := func(tok string, v int, blobs map[string]string) resp {
		var list []map[string]any
		for d, bl := range blobs {
			list = append(list, map[string]any{"device_id": d, "blob": bl})
		}
		return e.do("POST", "/v1/keys/rotate", tok, map[string]any{
			"key_version": v, "recovery_blob": blob(92, 3), "chain_blob": blob(60, 4), "device_blobs": list,
		})
	}
	// Wrong version.
	e.want(rotate(tokA, 3, map[string]string{b.Device.ID: blob(92, 5)}), 409, "key_version_conflict")
	e.want(rotate(tokA, 1, map[string]string{b.Device.ID: blob(92, 5)}), 409, "key_version_conflict")
	// B has a registered key and no blob (C has no key, so it is not required).
	r = rotate(tokA, 2, map[string]string{})
	e.want(r, 409, "devices_changed")
	if m := r.body["missing"].([]any); len(m) != 1 || m[0] != b.Device.ID {
		t.Fatalf("missing: %s", r.raw)
	}
	// A blob for a device outside the account is refused (400) and nothing is stored.
	_, outsider := e.signup("lee@example.com", true)
	outsiderID := e.ident(outsider).DeviceID
	r = rotate(tokA, 2, map[string]string{b.Device.ID: blob(92, 5), outsiderID: blob(92, 6)})
	e.want(r, 400, "invalid_request")
	if u := r.body["unexpected"].([]any); len(u) != 1 || u[0] != outsiderID {
		t.Fatalf("unexpected: %s", r.raw)
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
	e.want(e.do("PUT", "/v1/keys/device", tokB, map[string]any{"public_key": key32(2)}), 204, "")
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
	r = e.do("POST", "/v1/keys/rotate", tokA, map[string]any{"key_version": 2, "recovery_blob": blob(92, 3), "chain_blob": blob(60, 4),
		"device_blobs": []map[string]any{{"device_id": b.Device.ID, "blob": blob(92, 5)}}})
	e.want(r, 400, "invalid_request")
	e.want(e.do("POST", "/v1/keys/rotate", tokA, map[string]any{"key_version": 2, "recovery_blob": blob(92, 3), "chain_blob": blob(60, 4),
		"device_blobs": []map[string]any{}}), 200, "")
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
	_ = a
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
