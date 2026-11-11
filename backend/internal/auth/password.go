package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Argon2Params are the Argon2id cost parameters for account passwords (docs/ADR/0009-argon2id-passwords.md).
type Argon2Params struct {
	MemoryKiB uint32
	Time      uint32
	Threads   uint8
	SaltLen   int
	KeyLen    uint32
}

// DefaultArgon2 is the production cost: 19 MiB, 2 passes, 1 lane (OWASP's Argon2id baseline), 16-byte salt,
// 32-byte output. Changing it needs a new ADR; existing hashes are upgraded on the next successful sign-in.
var DefaultArgon2 = Argon2Params{MemoryKiB: 19456, Time: 2, Threads: 1, SaltLen: 16, KeyLen: 32}

// Password length limits (characters).
const (
	MinPasswordLen = 10
	MaxPasswordLen = 128
)

// Hasher hashes and verifies passwords with Argon2id, bounding how many hashes run at once so a burst of
// sign-ins cannot exhaust memory (each hash holds MemoryKiB).
type Hasher struct {
	params Argon2Params
	sem    chan struct{}
	dummy  string
}

// NewHasher returns a hasher running at most concurrency hashes at a time.
func NewHasher(p Argon2Params, concurrency int) *Hasher {
	if concurrency < 1 {
		concurrency = 1
	}
	h := &Hasher{params: p, sem: make(chan struct{}, concurrency)}
	// A hash of a random password, verified when the email is unknown so both paths cost one Argon2id run.
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	h.dummy, _ = h.hash(base64.RawStdEncoding.EncodeToString(b))
	return h
}

func (h *Hasher) acquire(ctx context.Context) error {
	select {
	case h.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Hasher) release() { <-h.sem }

// Hash returns a PHC-format Argon2id hash: $argon2id$v=19$m=…,t=…,p=…$salt$key (unpadded standard base64).
func (h *Hasher) Hash(ctx context.Context, password string) (string, error) {
	if err := h.acquire(ctx); err != nil {
		return "", err
	}
	defer h.release()
	return h.hash(password)
}

func (h *Hasher) hash(password string) (string, error) {
	salt := make([]byte, h.params.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	p := h.params
	key := argon2.IDKey([]byte(password), salt, p.Time, p.MemoryKiB, p.Threads, p.KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.MemoryKiB, p.Time, p.Threads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// Verify reports whether password matches encoded (constant-time compare) and whether the hash should be
// upgraded to the current parameters. An empty encoded verifies against a dummy hash and returns false, so
// an unknown email costs the same as a wrong password.
func (h *Hasher) Verify(ctx context.Context, encoded, password string) (ok, rehash bool, err error) {
	if err := h.acquire(ctx); err != nil {
		return false, false, err
	}
	defer h.release()
	unknown := encoded == ""
	if unknown {
		encoded = h.dummy
	}
	p, salt, key, err := decodeHash(encoded)
	if err != nil {
		return false, false, err
	}
	got := argon2.IDKey([]byte(password), salt, p.Time, p.MemoryKiB, p.Threads, uint32(len(key))) // #nosec G115 -- key length comes from our own encoded hash (32 bytes)
	match := subtle.ConstantTimeCompare(got, key) == 1
	if unknown {
		return false, false, nil
	}
	cur := h.params
	return match, match && (p.MemoryKiB != cur.MemoryKiB || p.Time != cur.Time || p.Threads != cur.Threads || uint32(len(key)) != cur.KeyLen), nil // #nosec G115 -- see above
}

var errBadHash = errors.New("malformed password hash")

func decodeHash(s string) (Argon2Params, []byte, []byte, error) {
	parts := strings.Split(s, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return Argon2Params{}, nil, nil, errBadHash
	}
	var v int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &v); err != nil || v != argon2.Version {
		return Argon2Params{}, nil, nil, errBadHash
	}
	var p Argon2Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.MemoryKiB, &p.Time, &p.Threads); err != nil ||
		p.MemoryKiB < 8 || p.Time < 1 || p.Threads < 1 {
		return Argon2Params{}, nil, nil, errBadHash
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[4])
	key, err2 := base64.RawStdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil || len(salt) < 8 || len(key) < 16 {
		return Argon2Params{}, nil, nil, errBadHash
	}
	p.SaltLen, p.KeyLen = len(salt), uint32(len(key)) // #nosec G115 -- bounded by the decoded hash
	return p, salt, key, nil
}

// commonPasswords are rejected outright (lowercased). Short entries are omitted because the length rule
// already rejects them.
var commonPasswords = map[string]bool{
	"1234567890": true, "12345678910": true, "123456789a": true, "0123456789": true, "1111111111": true,
	"0000000000": true, "1q2w3e4r5t": true, "qwertyuiop": true, "qwertyuiop1": true, "password12": true,
	"password123": true, "password1234": true, "passw0rd123": true, "iloveyou12": true, "iloveyou123": true,
	"abcdefghij": true, "abcd123456": true, "abc1234567": true, "qwerty1234": true, "qwerty12345": true,
	"qwerty123456": true, "1qaz2wsx3edc": true, "zaq12wsxcde3": true, "asdfghjkl1": true, "asdfghjkl;": true,
	"letmein123": true, "welcome123": true, "welcome1234": true, "admin12345": true, "administrator": true,
	"football123": true, "baseball123": true, "monkey12345": true, "dragon12345": true, "sunshine123": true,
	"princess123": true, "trustno1234": true, "changeme123": true, "shareanywhere": true, "share anywhere": true,
	"1234554321": true, "9876543210": true, "123123123123": true, "zxcvbnm123": true, "zxcvbnmasdf": true,
}

// ErrWeakPassword reports a password that fails the policy.
var ErrWeakPassword = errors.New("weak password")

// CheckPassword enforces 10–128 characters, not a common password, not only one repeated character, and not
// containing the email's local part (when it has at least 4 characters).
func CheckPassword(password, email string) error {
	n := utf8.RuneCountInString(password)
	if !utf8.ValidString(password) || n < MinPasswordLen || n > MaxPasswordLen {
		return ErrWeakPassword
	}
	lower := strings.ToLower(password)
	if commonPasswords[lower] {
		return ErrWeakPassword
	}
	first, _ := utf8.DecodeRuneInString(lower)
	if strings.Trim(lower, string(first)) == "" {
		return ErrWeakPassword
	}
	if local, _, ok := strings.Cut(strings.ToLower(email), "@"); ok && utf8.RuneCountInString(local) >= 4 && strings.Contains(lower, local) {
		return ErrWeakPassword
	}
	return nil
}
