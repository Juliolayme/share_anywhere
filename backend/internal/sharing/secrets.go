package sharing

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

//go:embed wordlist_en.txt
var wordlistRaw string

// Words is the 2048-word English list used for security words on every platform and language
// (BIP-0039 English list; docs/SECURITY_MODEL.md §3.1).
var Words = strings.Fields(wordlistRaw)

// keys derives purpose-specific keys from the server secret.
type keys struct {
	code []byte // HMAC for six-digit codes
	enc  []byte // AES-256-GCM for the sender's copy of code and link
	word []byte // HMAC for security words
	ip   []byte // HMAC for stored address keys (blocks)
}

func deriveKeys(secret []byte) keys {
	d := func(label string) []byte {
		m := hmac.New(sha256.New, secret)
		m.Write([]byte("sharing:" + label))
		return m.Sum(nil)
	}
	return keys{code: d("code"), enc: d("enc"), word: d("words"), ip: d("ip")}
}

// newCode returns a uniformly random six-digit code.
func newCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("%06d", n.Int64())
}

// ValidCode reports whether s is exactly six ASCII digits.
func ValidCode(s string) bool {
	if len(s) != 6 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// ipHash is what is stored instead of an address key: participants and blocks never hold raw addresses.
func (k keys) ipHash(ipKey string) string {
	if ipKey == "" {
		return ""
	}
	m := hmac.New(sha256.New, k.ip)
	m.Write([]byte(ipKey))
	return hex.EncodeToString(m.Sum(nil)[:16])
}

func (k keys) codeHMAC(code string) []byte {
	m := hmac.New(sha256.New, k.code)
	m.Write([]byte(code))
	return m.Sum(nil)
}

// newToken returns a 192-bit base64url token and its SHA-256 hash.
func newToken() (string, []byte) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	t := base64.RawURLEncoding.EncodeToString(b)
	return t, hashToken(t)
}

func hashToken(t string) []byte {
	h := sha256.Sum256([]byte(t))
	return h[:]
}

// ValidToken checks the shape of a link token or join ticket before any lookup.
func ValidToken(t string) bool {
	if len(t) < 22 || len(t) > 128 {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(t)
	return err == nil
}

func (k keys) seal(plain string) []byte {
	block, _ := aes.NewCipher(k.enc)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return gcm.Seal(nonce, nonce, []byte(plain), nil)
}

func (k keys) open(sealed []byte) (string, error) {
	block, _ := aes.NewCipher(k.enc)
	gcm, _ := cipher.NewGCM(block)
	if len(sealed) < gcm.NonceSize() {
		return "", errors.New("sealed value too short")
	}
	plain, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
	return string(plain), err
}

// securityWords derives three words (33 bits) from the session and the receiver device, so the sender and
// the receiver see the same words and a different device gets different ones.
func (k keys) securityWords(sessionID, deviceID string) []string {
	m := hmac.New(sha256.New, k.word)
	m.Write([]byte(sessionID + "|" + deviceID))
	sum := m.Sum(nil)
	v := binary.BigEndian.Uint64(sum[:8])
	out := make([]string, 3)
	for i := range out {
		out[i] = Words[(v>>(uint(i)*11))&0x7FF]
	}
	return out
}
