package auth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"strconv"
)

// Key authenticity (docs/ADR/0012-key-authenticity.md, docs/CLIPBOARD_PROTOCOL.md §1). Every ADK version v
// has an Ed25519 signing key derived from the ADK itself:
//
//	sign_seed(v)  = HKDF-SHA256(ikm = ADK(v), salt = empty, info = "sa-keyver-sign-v1", L = 32)
//	verify_key(v) = Ed25519 public key of sign_seed(v)
//
// so only a holder of ADK(v) can sign as version v. The server stores verify_key(v) for every version and
// checks two signatures with it: a rotation to v+1 must be signed by version v, and a device wrapping key
// must carry a proof signed by a version the device holds. The server never sees an ADK or a signing key;
// clients derive them (web/src/lib/crypto/). The byte layouts below are pinned by the key_authenticity
// section of shared/protocol/schemas/clipboard-vectors.json.
const (
	// SignInfo is the HKDF info of a version's signing seed.
	SignInfo = "sa-keyver-sign-v1"
	// AnchorInfo is the HKDF info of the recovery-anchor key derived from the recovery seed.
	AnchorInfo = "sa-recovery-anchor-v1"
	// verifyKeyLen and signatureLen are the Ed25519 public-key and signature sizes.
	verifyKeyLen = ed25519.PublicKeySize
	signatureLen = ed25519.SignatureSize
)

// RotationMessage is what the signing key of version v signs to authorize version v+1:
// "sa-rotate-v1|" + (v+1) + "|" + b64u(verify_key(v+1)) + "|" + b64u(SHA-256(chain_blob)).
func RotationMessage(newVersion int, newVerifyKey, chainBlob []byte) []byte {
	sum := sha256.Sum256(chainBlob)
	return []byte("sa-rotate-v1|" + strconv.Itoa(newVersion) + "|" + enc(newVerifyKey) + "|" + enc(sum[:]))
}

// DeviceKeyMessage is what the signing key of keyVersion signs to prove that the device holds that ADK
// version: "sa-devkey-v1|" + device ID (lowercase canonical UUID) + "|" + key_version + "|" + b64u(public_key).
func DeviceKeyMessage(deviceID string, keyVersion int, publicKey []byte) []byte {
	return []byte("sa-devkey-v1|" + deviceID + "|" + strconv.Itoa(keyVersion) + "|" + enc(publicKey))
}

// AnchorMessage is what the recovery-anchor key MACs (HMAC-SHA256) to bind verify_key(1) to the phrase:
// "sa-anchor-v1|" + b64u(verify_key(1)).
func AnchorMessage(verifyKey1 []byte) []byte {
	return []byte("sa-anchor-v1|" + enc(verifyKey1))
}

// verifySig checks an Ed25519 signature (RFC 8032, pure) by a 32-byte verify key.
func verifySig(verifyKey, msg, sig []byte) bool {
	return len(verifyKey) == verifyKeyLen && len(sig) == signatureLen && ed25519.Verify(ed25519.PublicKey(verifyKey), msg, sig)
}
