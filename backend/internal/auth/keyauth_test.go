package auth

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Client-side derivations (what web/src/lib/crypto/ does), used by the tests to act as a real ADK holder.

// signKey is the Ed25519 signing key of an ADK version.
func signKey(adk []byte) ed25519.PrivateKey {
	seed, err := hkdf.Key(sha256.New, adk, nil, SignInfo, ed25519.SeedSize)
	if err != nil {
		panic(err) // HKDF-SHA256 cannot fail for 32 bytes
	}
	return ed25519.NewKeyFromSeed(seed)
}

func verifyKeyOf(adk []byte) []byte { return []byte(signKey(adk).Public().(ed25519.PublicKey)) }

func recoveryAnchor(recoverySeed, verifyKey1 []byte) (key, anchor []byte) {
	key, err := hkdf.Key(sha256.New, recoverySeed, nil, AnchorInfo, 32)
	if err != nil {
		panic(err)
	}
	m := hmac.New(sha256.New, key)
	m.Write(AnchorMessage(verifyKey1))
	return key, m.Sum(nil)
}

func seq(start byte, n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

// keyAuthVectors is the key_authenticity section of clipboard-vectors.json (field order = file order).
type keyAuthVectors struct {
	InfoSign    string `json:"info_sign"`
	SignSeedV1  string `json:"sign_seed_v1"`
	VerifyKeyV1 string `json:"verify_key_v1"`
	SignSeedV2  string `json:"sign_seed_v2"`
	VerifyKeyV2 string `json:"verify_key_v2"`
	Rotation    struct {
		KeyVersion      int    `json:"key_version"`
		ChainBlobSHA256 string `json:"chain_blob_sha256"`
		MessageUTF8     string `json:"message_utf8"`
		Signature       string `json:"signature"`
	} `json:"rotation"`
	DeviceKey struct {
		DeviceID    string `json:"device_id"`
		KeyVersion  int    `json:"key_version"`
		PublicKey   string `json:"public_key"`
		MessageUTF8 string `json:"message_utf8"`
		Proof       string `json:"proof"`
	} `json:"device_key"`
	Anchor struct {
		RecoverySeed   string `json:"recovery_seed"`
		AnchorKey      string `json:"anchor_key"`
		MessageUTF8    string `json:"message_utf8"`
		RecoveryAnchor string `json:"recovery_anchor"`
	} `json:"anchor"`
}

type vectorsFile struct {
	Chain struct {
		ADKv1 string `json:"adk_v1"`
		ADKv2 string `json:"adk_v2"`
		Blob  string `json:"blob"`
	} `json:"chain"`
	KeyAuthenticity *keyAuthVectors `json:"key_authenticity"`
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex %q: %v", s, err)
	}
	return b
}

// buildKeyAuthVectors computes the section from the fixed inputs (chain.adk_v1, chain.adk_v2, chain.blob,
// a fixed device ID, public key 0x40..0x5f, and recovery seed 0x60..0x7f).
func buildKeyAuthVectors(t *testing.T, adk1, adk2, chainBlob []byte) keyAuthVectors {
	t.Helper()
	sk1, sk2 := signKey(adk1), signKey(adk2)
	vk1, vk2 := verifyKeyOf(adk1), verifyKeyOf(adk2)
	var v keyAuthVectors
	v.InfoSign = SignInfo
	v.SignSeedV1, v.VerifyKeyV1 = hex.EncodeToString(sk1.Seed()), hex.EncodeToString(vk1)
	v.SignSeedV2, v.VerifyKeyV2 = hex.EncodeToString(sk2.Seed()), hex.EncodeToString(vk2)

	sum := sha256.Sum256(chainBlob)
	rot := RotationMessage(2, vk2, chainBlob)
	v.Rotation.KeyVersion, v.Rotation.ChainBlobSHA256 = 2, hex.EncodeToString(sum[:])
	v.Rotation.MessageUTF8, v.Rotation.Signature = string(rot), hex.EncodeToString(ed25519.Sign(sk1, rot))

	const deviceID = "00000000-0000-4000-8000-000000000001"
	pub := seq(0x40, 32)
	dk := DeviceKeyMessage(deviceID, 1, pub)
	v.DeviceKey.DeviceID, v.DeviceKey.KeyVersion, v.DeviceKey.PublicKey = deviceID, 1, hex.EncodeToString(pub)
	v.DeviceKey.MessageUTF8, v.DeviceKey.Proof = string(dk), hex.EncodeToString(ed25519.Sign(sk1, dk))

	seed := seq(0x60, 32)
	key, anchor := recoveryAnchor(seed, vk1)
	v.Anchor.RecoverySeed, v.Anchor.AnchorKey = hex.EncodeToString(seed), hex.EncodeToString(key)
	v.Anchor.MessageUTF8, v.Anchor.RecoveryAnchor = string(AnchorMessage(vk1)), hex.EncodeToString(anchor)
	return v
}

// TestKeyAuthenticityVectors recomputes every value of the key_authenticity section of
// shared/protocol/schemas/clipboard-vectors.json (the Web verifies the same file in vectors.test.ts) and
// checks the server-side verification accepts exactly those signatures. PRINT_KEYAUTH_VECTORS=1 prints the
// section (how it was generated).
func TestKeyAuthenticityVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "protocol", "schemas", "clipboard-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f vectorsFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	adk1, adk2, chainBlob := unhex(t, f.Chain.ADKv1), unhex(t, f.Chain.ADKv2), unhex(t, f.Chain.Blob)
	want := buildKeyAuthVectors(t, adk1, adk2, chainBlob)
	if os.Getenv("PRINT_KEYAUTH_VECTORS") == "1" {
		out, _ := json.MarshalIndent(want, "", "  ")
		t.Logf("key_authenticity:\n%s", out)
	}
	if f.KeyAuthenticity == nil {
		t.Fatal("clipboard-vectors.json has no key_authenticity section")
	}
	got := *f.KeyAuthenticity
	if got != want {
		gj, _ := json.MarshalIndent(got, "", "  ")
		wj, _ := json.MarshalIndent(want, "", "  ")
		t.Fatalf("key_authenticity differs from the derivation\n got: %s\nwant: %s", gj, wj)
	}
	// The server-side checks accept the published signatures and nothing else.
	vk1, vk2 := unhex(t, got.VerifyKeyV1), unhex(t, got.VerifyKeyV2)
	if !verifySig(vk1, []byte(got.Rotation.MessageUTF8), unhex(t, got.Rotation.Signature)) {
		t.Fatal("rotation signature must verify with verify_key_v1")
	}
	if verifySig(vk2, []byte(got.Rotation.MessageUTF8), unhex(t, got.Rotation.Signature)) {
		t.Fatal("rotation signature must not verify with verify_key_v2")
	}
	if !verifySig(vk1, []byte(got.DeviceKey.MessageUTF8), unhex(t, got.DeviceKey.Proof)) {
		t.Fatal("device proof must verify with verify_key_v1")
	}
	other := DeviceKeyMessage("00000000-0000-4000-8000-000000000002", 1, unhex(t, got.DeviceKey.PublicKey))
	if verifySig(vk1, other, unhex(t, got.DeviceKey.Proof)) {
		t.Fatal("device proof must not verify for another device ID")
	}
	if !bytes.HasPrefix([]byte(got.Rotation.MessageUTF8), []byte("sa-rotate-v1|2|")) ||
		!bytes.HasPrefix([]byte(got.DeviceKey.MessageUTF8), []byte("sa-devkey-v1|00000000-0000-4000-8000-000000000001|1|")) ||
		!bytes.HasPrefix([]byte(got.Anchor.MessageUTF8), []byte("sa-anchor-v1|")) {
		t.Fatal("message prefixes changed")
	}
}
