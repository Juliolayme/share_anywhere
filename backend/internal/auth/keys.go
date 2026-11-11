package auth

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
)

// The server stores only public keys and opaque wrapped-key blobs (PRD §7.5, docs/CLIPBOARD_PROTOCOL.md):
// it can check sizes and versions but can never unwrap anything.

// Argon2Spec is the recovery-phrase KDF cost the client used (stored so another device can re-derive).
type Argon2Spec struct {
	M int `json:"m"`
	T int `json:"t"`
	P int `json:"p"`
}

func (a Argon2Spec) valid() bool {
	return a.M >= 8192 && a.M <= 1<<20 && a.T >= 1 && a.T <= 10 && a.P >= 1 && a.P <= 4
}

// RecoveryInfo is the public recovery metadata.
type RecoveryInfo struct {
	PublicKey string     `json:"public_key"`
	Salt      string     `json:"salt"`
	Params    Argon2Spec `json:"params"`
}

// DeviceKey is one added device and its wrapping public key with the proof that it holds ADK(key_version)
// (all null until registered).
type DeviceKey struct {
	DeviceID   string  `json:"device_id"`
	PublicKey  *string `json:"public_key"`
	KeyVersion *int    `json:"key_version"`
	Proof      *string `json:"proof"`
}

// PendingBlob is an ADK version wrapped for the caller by a rotation.
type PendingBlob struct {
	KeyVersion   int    `json:"key_version"`
	Blob         string `json:"blob"`
	FromDeviceID string `json:"from_device_id"`
}

// KeysState is GET /v1/keys.
type KeysState struct {
	KeyVersion int           `json:"key_version"`
	Recovery   *RecoveryInfo `json:"recovery"`
	Devices    []DeviceKey   `json:"devices"`
	Pending    []PendingBlob `json:"pending"`
}

func validKey(s string) ([]byte, bool) {
	b, ok := b64(s)
	return b, ok && len(b) == keyLen
}

func validBlob(s string, minLen int) ([]byte, bool) {
	b, ok := b64(s)
	return b, ok && len(b) >= minLen && len(b) <= maxBlob
}

// Keys returns the account's key state for the calling (added) device.
func (s *Service) Keys(ctx context.Context, id access.Identity) (KeysState, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return KeysState{}, err
	}
	now := s.cfg.Clock.Now()
	out := KeysState{Devices: []DeviceKey{}, Pending: []PendingBlob{}}
	var pub, salt []byte
	var m, t, p *int
	if err := s.cfg.Pool.QueryRow(ctx,
		`SELECT key_version, recovery_public_key, recovery_salt, recovery_m, recovery_t, recovery_p FROM account_keys WHERE user_id = $1::uuid`,
		se.UserID).Scan(&out.KeyVersion, &pub, &salt, &m, &t, &p); err != nil {
		return KeysState{}, err
	}
	if pub != nil && m != nil && t != nil && p != nil {
		out.Recovery = &RecoveryInfo{PublicKey: enc(pub), Salt: enc(salt), Params: Argon2Spec{M: *m, T: *t, P: *p}}
	}
	rows, err := s.cfg.Pool.Query(ctx,
		`SELECT a.device_id::text, k.public_key, k.key_version, k.proof FROM auth_sessions a
		   JOIN devices d ON d.id = a.device_id AND d.revoked_at IS NULL AND d.expires_at > $2
		   LEFT JOIN device_keys k ON k.device_id = a.device_id AND k.user_id = a.user_id
		  WHERE a.user_id = $1::uuid AND a.revoked_at IS NULL AND a.expires_at > $2 AND a.device_added
		  ORDER BY a.created_at`, se.UserID, now)
	if err != nil {
		return KeysState{}, err
	}
	for rows.Next() {
		var dk DeviceKey
		var k, proof []byte
		if err := rows.Scan(&dk.DeviceID, &k, &dk.KeyVersion, &proof); err != nil {
			rows.Close()
			return KeysState{}, err
		}
		if k != nil {
			e, p := enc(k), enc(proof)
			dk.PublicKey, dk.Proof = &e, &p
		}
		out.Devices = append(out.Devices, dk)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return KeysState{}, err
	}
	rows, err = s.cfg.Pool.Query(ctx,
		`SELECT key_version, blob, from_device_id::text FROM device_key_blobs WHERE device_id = $1::uuid AND user_id = $2::uuid ORDER BY key_version`,
		se.DeviceID, se.UserID)
	if err != nil {
		return KeysState{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var pb PendingBlob
		var b []byte
		if err := rows.Scan(&pb.KeyVersion, &b, &pb.FromDeviceID); err != nil {
			return KeysState{}, err
		}
		pb.Blob = enc(b)
		out.Pending = append(out.Pending, pb)
	}
	return out, rows.Err()
}

// RegisterKeyInput is PUT /v1/keys/device.
type RegisterKeyInput struct {
	PublicKey  string `json:"public_key"`
	KeyVersion int    `json:"key_version"`
	Proof      string `json:"proof"`
}

// verifyKeyAt returns verify_key(v) of the account inside tx (nil for a legacy row, ErrNoRows if the
// version does not exist).
func verifyKeyAt(ctx context.Context, tx pgx.Tx, userID string, v int) ([]byte, error) {
	var vk []byte
	err := tx.QueryRow(ctx, `SELECT verify_key FROM account_key_versions WHERE user_id = $1::uuid AND key_version = $2`, userID, v).Scan(&vk)
	return vk, err
}

// RegisterDeviceKey stores (or replaces) the calling device's X25519 wrapping public key. The proof must be
// a signature by the signing key of ADK(key_version) over the caller's device ID (from the token, never the
// body), so only a device that already holds the ADK (setup, pairing, or recovery done) can register, and
// rotations only ever wrap new keys to such devices (docs/ADR/0012-key-authenticity.md). Replacing the key
// drops blobs wrapped to the old key, which the device can no longer open.
func (s *Service) RegisterDeviceKey(ctx context.Context, id access.Identity, in RegisterKeyInput) error {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return err
	}
	pub, ok1 := validKey(in.PublicKey)
	proof, ok2 := b64(in.Proof)
	if !ok1 || !ok2 || len(proof) != signatureLen || in.KeyVersion < 1 {
		return ErrInvalid
	}
	return pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		var current int
		if err := tx.QueryRow(ctx, `SELECT key_version FROM account_keys WHERE user_id = $1::uuid FOR SHARE`, se.UserID).Scan(&current); err != nil {
			return err
		}
		if in.KeyVersion > current {
			return ErrDeviceKeyUnproven
		}
		vk, err := verifyKeyAt(ctx, tx, se.UserID, in.KeyVersion)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrDeviceKeyUnproven
		}
		if err != nil {
			return err
		}
		if vk == nil {
			return ErrKeysLegacy
		}
		if !verifySig(vk, DeviceKeyMessage(se.DeviceID, in.KeyVersion, pub), proof) {
			return ErrDeviceKeyUnproven
		}
		var old []byte
		err = tx.QueryRow(ctx, `SELECT public_key FROM device_keys WHERE device_id = $1::uuid FOR UPDATE`, se.DeviceID).Scan(&old)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if old != nil && string(old) != string(pub) {
			if _, err := tx.Exec(ctx, `DELETE FROM device_key_blobs WHERE device_id = $1::uuid`, se.DeviceID); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO device_keys (device_id, user_id, public_key, key_version, proof, created_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
			 ON CONFLICT (device_id) DO UPDATE SET user_id = EXCLUDED.user_id, public_key = EXCLUDED.public_key,
			        key_version = EXCLUDED.key_version, proof = EXCLUDED.proof, created_at = EXCLUDED.created_at`,
			se.DeviceID, se.UserID, pub, in.KeyVersion, proof, s.cfg.Clock.Now())
		return err
	})
}

// SetupInput is POST /v1/keys/setup.
type SetupInput struct {
	RecoveryPublicKey string     `json:"recovery_public_key"`
	Salt              string     `json:"salt"`
	Params            Argon2Spec `json:"params"`
	RecoveryBlob      string     `json:"recovery_blob"`
	// VerifyKey is verify_key(1), the Ed25519 public key derived from ADK(1).
	VerifyKey string `json:"verify_key"`
	// RecoveryAnchor is HMAC-SHA256 of AnchorMessage(verify_key(1)) under a key derived from the recovery seed.
	RecoveryAnchor string `json:"recovery_anchor"`
}

// lockKeys locks the account's key row for the rest of tx and returns the current version.
func lockKeys(ctx context.Context, tx pgx.Tx, userID string) (int, error) {
	var v int
	err := tx.QueryRow(ctx, `SELECT key_version FROM account_keys WHERE user_id = $1::uuid FOR UPDATE`, userID).Scan(&v)
	return v, err
}

// SetupKeys records the first ADK version (wrapped to the recovery key) and the recovery metadata.
func (s *Service) SetupKeys(ctx context.Context, id access.Identity, in SetupInput) (int, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return 0, err
	}
	pub, ok1 := validKey(in.RecoveryPublicKey)
	salt, ok2 := b64(in.Salt)
	blob, ok3 := validBlob(in.RecoveryBlob, minWrapBlob)
	vk, ok4 := validKey(in.VerifyKey)
	anchor, ok5 := validKey(in.RecoveryAnchor)
	if !ok1 || !ok2 || len(salt) < 16 || len(salt) > 64 || !ok3 || !ok4 || !ok5 || !in.Params.valid() {
		return 0, ErrInvalid
	}
	now := s.cfg.Clock.Now()
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		v, err := lockKeys(ctx, tx, se.UserID)
		if err != nil {
			return err
		}
		if v >= 1 {
			return ErrKeysExist
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO account_key_versions (user_id, key_version, recovery_blob, chain_blob, verify_key, signature, created_by_device_id, created_at)
			 VALUES ($1::uuid, 1, $2, NULL, $3, NULL, $4::uuid, $5)`, se.UserID, blob, vk, se.DeviceID, now); err != nil {
			return err
		}
		_, err = tx.Exec(ctx,
			`UPDATE account_keys SET key_version = 1, recovery_public_key = $2, recovery_salt = $3, recovery_m = $4,
			        recovery_t = $5, recovery_p = $6, recovery_anchor = $7, updated_at = $8 WHERE user_id = $1::uuid`,
			se.UserID, pub, salt, in.Params.M, in.Params.T, in.Params.P, anchor, now)
		return err
	})
	if err != nil {
		return 0, err
	}
	return 1, nil
}

// Recovery is GET /v1/keys/recovery.
type Recovery struct {
	KeyVersion   int        `json:"key_version"`
	RecoveryBlob string     `json:"recovery_blob"`
	Salt         string     `json:"salt"`
	Params       Argon2Spec `json:"params"`
	// RecoveryAnchor authenticates verify_key(1) to a phrase holder; null for legacy accounts.
	RecoveryAnchor *string `json:"recovery_anchor"`
}

// GetRecovery returns the newest ADK wrapped to the recovery public key.
func (s *Service) GetRecovery(ctx context.Context, id access.Identity) (Recovery, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return Recovery{}, err
	}
	var r Recovery
	var blob, salt, anchor []byte
	err = s.cfg.Pool.QueryRow(ctx,
		`SELECT k.key_version, v.recovery_blob, k.recovery_salt, k.recovery_m, k.recovery_t, k.recovery_p, k.recovery_anchor
		   FROM account_keys k JOIN account_key_versions v ON v.user_id = k.user_id AND v.key_version = k.key_version
		  WHERE k.user_id = $1::uuid`, se.UserID).Scan(&r.KeyVersion, &blob, &salt, &r.Params.M, &r.Params.T, &r.Params.P, &anchor)
	if errors.Is(err, pgx.ErrNoRows) {
		return Recovery{}, ErrNotFound
	}
	if err != nil {
		return Recovery{}, err
	}
	r.RecoveryBlob, r.Salt = enc(blob), enc(salt)
	if anchor != nil {
		a := enc(anchor)
		r.RecoveryAnchor = &a
	}
	return r, nil
}

// ChainLink is ADK(v-1) wrapped with ADK(v).
type ChainLink struct {
	KeyVersion int    `json:"key_version"`
	Blob       string `json:"blob"`
}

// KeyVersionInfo is one ADK version's verify key and the signature by the previous version that authorized
// it (null for version 1). Both are null only for legacy rows set up before key verification existed.
type KeyVersionInfo struct {
	KeyVersion int     `json:"key_version"`
	VerifyKey  *string `json:"verify_key"`
	Signature  *string `json:"signature"`
}

// ChainState is GET /v1/keys/chain.
type ChainState struct {
	Chain    []ChainLink      `json:"chain"`
	Versions []KeyVersionInfo `json:"versions"`
}

// Chain returns every chain blob and every version's verify key and signature, oldest first, so a client
// can check the whole version list (docs/CLIPBOARD_PROTOCOL.md §1).
func (s *Service) Chain(ctx context.Context, id access.Identity) (ChainState, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return ChainState{}, err
	}
	rows, err := s.cfg.Pool.Query(ctx,
		`SELECT key_version, chain_blob, verify_key, signature FROM account_key_versions WHERE user_id = $1::uuid ORDER BY key_version`, se.UserID)
	if err != nil {
		return ChainState{}, err
	}
	defer rows.Close()
	out := ChainState{Chain: []ChainLink{}, Versions: []KeyVersionInfo{}}
	for rows.Next() {
		var v KeyVersionInfo
		var chain, vk, sig []byte
		if err := rows.Scan(&v.KeyVersion, &chain, &vk, &sig); err != nil {
			return ChainState{}, err
		}
		if chain != nil {
			out.Chain = append(out.Chain, ChainLink{KeyVersion: v.KeyVersion, Blob: enc(chain)})
		}
		v.VerifyKey, v.Signature = optEnc(vk), optEnc(sig)
		out.Versions = append(out.Versions, v)
	}
	return out, rows.Err()
}

func optEnc(b []byte) *string {
	if b == nil {
		return nil
	}
	e := enc(b)
	return &e
}

// DeviceBlob is a new ADK version wrapped for one device.
type DeviceBlob struct {
	DeviceID string `json:"device_id"`
	Blob     string `json:"blob"`
}

// RotateInput is POST /v1/keys/rotate.
type RotateInput struct {
	KeyVersion   int          `json:"key_version"`
	RecoveryBlob string       `json:"recovery_blob"`
	ChainBlob    string       `json:"chain_blob"`
	DeviceBlobs  []DeviceBlob `json:"device_blobs"`
	// VerifyKey is verify_key(v+1).
	VerifyKey string `json:"verify_key"`
	// Signature is by the signing key of version v over RotationMessage(v+1, verify_key, chain_blob).
	Signature string `json:"signature"`
}

// Rotate records ADK version current+1 atomically under the account's key-row lock. The rotation must be
// signed by the signing key of the current version (only a holder of ADK(v) can authorize v+1), checked
// against the stored verify_key(v): a device that only knows the password cannot plant a key of its own
// choosing (403 rotation_unauthorized, nothing stored; docs/ADR/0012-key-authenticity.md). Every other added
// device with a registered wrapping key must get a blob (409 devices_changed lists the missing ones), so no
// remaining device is locked out; a blob for a device that is not an added device of the account is refused
// (400 with unexpected), so no removed device gets the key. The caller may include a safety copy for itself,
// delivered through its own pending list like the others.
func (s *Service) Rotate(ctx context.Context, id access.Identity, in RotateInput) (int, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return 0, err
	}
	rec, ok1 := validBlob(in.RecoveryBlob, minWrapBlob)
	chain, ok2 := validBlob(in.ChainBlob, minChainBlob)
	newVK, ok3 := validKey(in.VerifyKey)
	sig, ok4 := b64(in.Signature)
	if !ok1 || !ok2 || !ok3 || !ok4 || len(sig) != signatureLen || in.KeyVersion < 1 || len(in.DeviceBlobs) > 100 {
		return 0, ErrInvalid
	}
	blobs := map[string][]byte{}
	for _, d := range in.DeviceBlobs {
		b, ok := validBlob(d.Blob, minWrapBlob)
		if _, dup := blobs[d.DeviceID]; !ok || dup || !isUUID(d.DeviceID) {
			return 0, ErrInvalid
		}
		blobs[d.DeviceID] = b
	}
	now := s.cfg.Clock.Now()
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		v, err := lockKeys(ctx, tx, se.UserID)
		if err != nil {
			return err
		}
		if v < 1 || in.KeyVersion != v+1 {
			return ErrKeyVersion
		}
		vk, err := verifyKeyAt(ctx, tx, se.UserID, v)
		if err != nil {
			return err
		}
		if vk == nil {
			return ErrKeysLegacy
		}
		if !verifySig(vk, RotationMessage(in.KeyVersion, newVK, chain), sig) {
			return ErrRotationUnauthorized
		}
		// Every live added device of the account (the caller included) and whether it registered a key.
		rows, err := tx.Query(ctx,
			`SELECT a.device_id::text, k.device_id IS NOT NULL FROM auth_sessions a
			   JOIN devices d ON d.id = a.device_id AND d.revoked_at IS NULL AND d.expires_at > $2
			   LEFT JOIN device_keys k ON k.device_id = a.device_id AND k.user_id = a.user_id
			  WHERE a.user_id = $1::uuid AND a.revoked_at IS NULL AND a.expires_at > $2 AND a.device_added`, se.UserID, now)
		if err != nil {
			return err
		}
		added := map[string]bool{} // device ID → has a registered key
		for rows.Next() {
			var d string
			var hasKey bool
			if err := rows.Scan(&d, &hasKey); err != nil {
				rows.Close()
				return err
			}
			added[d] = hasKey
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		// Blobs may go only to added devices of the account; the caller may include a safety copy for itself.
		unexpected := []string{}
		for d := range blobs {
			if _, ok := added[d]; !ok {
				unexpected = append(unexpected, d)
			}
		}
		if len(unexpected) > 0 {
			sort.Strings(unexpected)
			return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Msg: "device_blobs names devices that are not added to this account.",
				Extra: map[string]any{"unexpected": unexpected}}
		}
		missing := []string{}
		for d, hasKey := range added {
			if _, ok := blobs[d]; !ok && hasKey && d != se.DeviceID {
				missing = append(missing, d)
			}
		}
		if len(missing) > 0 {
			sort.Strings(missing)
			return &Error{Status: http.StatusConflict, Code: "devices_changed", Msg: errDevicesChangedMsg,
				Extra: map[string]any{"missing": missing}}
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO account_key_versions (user_id, key_version, recovery_blob, chain_blob, verify_key, signature, created_by_device_id, created_at)
			 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8)`, se.UserID, in.KeyVersion, rec, chain, newVK, sig, se.DeviceID, now); err != nil {
			return err
		}
		for d, b := range blobs {
			if _, err := tx.Exec(ctx,
				`INSERT INTO device_key_blobs (device_id, key_version, user_id, blob, from_device_id, created_at)
				 VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6)`, d, in.KeyVersion, se.UserID, b, se.DeviceID, now); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `UPDATE account_keys SET key_version = $2, updated_at = $3 WHERE user_id = $1::uuid`, se.UserID, in.KeyVersion, now)
		return err
	})
	if err != nil {
		return 0, err
	}
	return in.KeyVersion, nil
}

// AckPending deletes a rotation blob the caller has stored (idempotent).
func (s *Service) AckPending(ctx context.Context, id access.Identity, keyVersion int) error {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return err
	}
	_, err = s.cfg.Pool.Exec(ctx, `DELETE FROM device_key_blobs WHERE device_id = $1::uuid AND key_version = $2`, se.DeviceID, keyVersion)
	return err
}

// Pairing is POST /v1/keys/pairings.
type Pairing struct {
	PairingID string    `json:"pairing_id"`
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CreatePairing starts a pairing for the calling (new) device, replacing any earlier one. The code is 128
// random bits (base64url), valid 10 minutes, stored only as SHA-256.
func (s *Service) CreatePairing(ctx context.Context, id access.Identity, ipKey, ephemeralPublicKey string) (Pairing, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return Pairing{}, err
	}
	eph, ok := validKey(ephemeralPublicKey)
	if !ok {
		return Pairing{}, ErrInvalid
	}
	if err := allow(s.cfg.Limits.PairingCreate, se.DeviceID, s.cfg.Limits.PairingIP, ipKey); err != nil {
		return Pairing{}, err
	}
	code, hash := newToken(16)
	now := s.cfg.Clock.Now()
	p := Pairing{PairingID: newID(), Code: code, ExpiresAt: now.Add(PairingTTL).UTC()}
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM device_pairings WHERE new_device_id = $1::uuid`, se.DeviceID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO device_pairings (id, user_id, new_device_id, ephemeral_public_key, code_hash, created_at, expires_at)
			 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`, p.PairingID, se.UserID, se.DeviceID, eph, hash, now, p.ExpiresAt)
		if isUniqueViolation(err, "") {
			return ErrPairingConflict
		}
		return err
	})
	if err != nil {
		return Pairing{}, err
	}
	return p, nil
}

// PairingPeer is what the existing device learns from a code.
type PairingPeer struct {
	PairingID          string `json:"pairing_id"`
	EphemeralPublicKey string `json:"ephemeral_public_key"`
	DeviceID           string `json:"device_id"`
	DeviceName         string `json:"device_name"`
}

const openPairing = `p.code_hash = $1 AND p.user_id = $2::uuid AND p.new_device_id <> $3::uuid AND p.expires_at > $4
	AND p.wrapped_at IS NULL AND p.consumed_at IS NULL`

// LookupPairing resolves a code for an existing device of the same account. Unknown, expired, used,
// other-account, and own codes are all 404.
func (s *Service) LookupPairing(ctx context.Context, id access.Identity, ipKey, code string) (PairingPeer, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return PairingPeer{}, err
	}
	if err := allow(s.cfg.Limits.PairingLookup, se.DeviceID, s.cfg.Limits.PairingIP, ipKey); err != nil {
		return PairingPeer{}, err
	}
	if code == "" || len(code) > 64 {
		return PairingPeer{}, ErrNotFound
	}
	var p PairingPeer
	var eph []byte
	err = s.cfg.Pool.QueryRow(ctx,
		`SELECT p.id::text, p.ephemeral_public_key, p.new_device_id::text, d.display_name
		   FROM device_pairings p JOIN devices d ON d.id = p.new_device_id AND d.revoked_at IS NULL
		  WHERE `+openPairing, hashToken(code), se.UserID, se.DeviceID, s.cfg.Clock.Now()).Scan(&p.PairingID, &eph, &p.DeviceID, &p.DeviceName)
	if errors.Is(err, pgx.ErrNoRows) {
		return PairingPeer{}, ErrNotFound
	}
	if err != nil {
		return PairingPeer{}, err
	}
	p.EphemeralPublicKey = enc(eph)
	return p, nil
}

// WrapInput is POST /v1/keys/pairings/by-code/{code}/wrap.
type WrapInput struct {
	KeyVersion      int    `json:"key_version"`
	SenderPublicKey string `json:"sender_public_key"`
	Blob            string `json:"blob"`
}

// WrapPairing stores the newest ADK wrapped for the new device; accepted once. sender_public_key must be the
// caller's registered (therefore proven, see RegisterDeviceKey) wrapping key, so a pairing blob always comes
// from a device that showed it holds the ADK (403 device_key_unproven otherwise).
func (s *Service) WrapPairing(ctx context.Context, id access.Identity, code string, in WrapInput) error {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return err
	}
	sender, ok1 := validKey(in.SenderPublicKey)
	blob, ok2 := validBlob(in.Blob, minWrapBlob)
	if !ok1 || !ok2 {
		return ErrInvalid
	}
	if code == "" || len(code) > 64 {
		return ErrNotFound
	}
	now := s.cfg.Clock.Now()
	return pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		var current int
		if err := tx.QueryRow(ctx, `SELECT key_version FROM account_keys WHERE user_id = $1::uuid FOR SHARE`, se.UserID).Scan(&current); err != nil {
			return err
		}
		var registered []byte
		err := tx.QueryRow(ctx, `SELECT public_key FROM device_keys WHERE device_id = $1::uuid AND user_id = $2::uuid`, se.DeviceID, se.UserID).Scan(&registered)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		proven := bytes.Equal(registered, sender)
		if proven {
			tag, err := tx.Exec(ctx,
				`UPDATE device_pairings p SET key_version = $5, sender_public_key = $6, blob = $7, wrapped_by_device_id = $3::uuid, wrapped_at = $4
				  WHERE `+openPairing+` AND $5 = $8::int AND $5 >= 1`,
				hashToken(code), se.UserID, se.DeviceID, now, in.KeyVersion, sender, blob, current)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 1 {
				return nil
			}
		}
		// Tell a pairing that is gone apart from an unproven sender key or a stale key version.
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM device_pairings p WHERE `+openPairing+`)`,
			hashToken(code), se.UserID, se.DeviceID, now).Scan(&exists); err != nil {
			return err
		}
		switch {
		case !exists:
			return ErrNotFound
		case !proven:
			return ErrDeviceKeyUnproven
		default:
			return ErrKeyVersion
		}
	})
}

// PairingStatus is GET /v1/keys/pairings/{id}.
type PairingStatus struct {
	Status          string  `json:"status"`
	KeyVersion      *int    `json:"key_version,omitempty"`
	SenderPublicKey *string `json:"sender_public_key,omitempty"`
	Blob            *string `json:"blob,omitempty"`
}

// PairingResult returns the pairing's status to the new device; the wrapped blob is returned once, then the
// pairing is consumed and its blob deleted (later calls report expired).
func (s *Service) PairingResult(ctx context.Context, id access.Identity, pairingID string) (PairingStatus, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return PairingStatus{}, err
	}
	if !isUUID(pairingID) {
		return PairingStatus{}, ErrNotFound
	}
	now := s.cfg.Clock.Now()
	var out PairingStatus
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		var expires time.Time
		var wrappedAt, consumedAt *time.Time
		var kv *int
		var sender, blob []byte
		err := tx.QueryRow(ctx,
			`SELECT expires_at, wrapped_at, consumed_at, key_version, sender_public_key, blob FROM device_pairings
			  WHERE id = $1::uuid AND new_device_id = $2::uuid AND user_id = $3::uuid FOR UPDATE`,
			pairingID, se.DeviceID, se.UserID).Scan(&expires, &wrappedAt, &consumedAt, &kv, &sender, &blob)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		switch {
		case consumedAt != nil || !now.Before(expires):
			out.Status = "expired"
		case wrappedAt == nil:
			out.Status = "waiting"
		default:
			sp, b := enc(sender), enc(blob)
			out = PairingStatus{Status: "ready", KeyVersion: kv, SenderPublicKey: &sp, Blob: &b}
			_, err = tx.Exec(ctx, `UPDATE device_pairings SET consumed_at = $2, blob = NULL WHERE id = $1::uuid`, pairingID, now)
		}
		return err
	})
	return out, err
}
