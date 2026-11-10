package devices

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/bits"
	"strings"
	"sync"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

// PoWTTL is how long a proof-of-work challenge stays valid.
const PoWTTL = 5 * time.Minute

// Proof-of-work errors.
var (
	ErrPoWInvalid = errors.New("proof of work invalid")
	ErrPoWExpired = errors.New("proof of work expired")
	ErrPoWReused  = errors.New("proof of work already used")
)

// PoW issues HMAC-signed challenges bound to the caller's address key and verifies solutions:
// SHA-256(token + ":" + solution) must start with `difficulty` zero bits (docs/SECURITY_MODEL.md §4).
type PoW struct {
	secret     []byte
	difficulty int
	clock      clock.Clock
	mu         sync.Mutex
	used       map[string]time.Time
}

// NewPoW returns a challenge service.
func NewPoW(secret []byte, difficulty int, c clock.Clock) *PoW {
	return &PoW{secret: secret, difficulty: difficulty, clock: c, used: map[string]time.Time{}}
}

type powPayload struct {
	Nonce string `json:"n"`
	Diff  int    `json:"d"`
	Exp   int64  `json:"e"`
	Who   string `json:"w"`
}

func (p *PoW) mac(b []byte) []byte {
	m := hmac.New(sha256.New, p.secret)
	m.Write([]byte("pow:"))
	m.Write(b)
	return m.Sum(nil)
}

// who binds a challenge to an address without putting the address in the token.
func (p *PoW) who(addrKey string) string {
	return base64.RawURLEncoding.EncodeToString(p.mac([]byte("who:" + addrKey))[:12])
}

// Challenge returns a token and its difficulty for addrKey.
func (p *PoW) Challenge(addrKey string) (string, int) {
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	payload, _ := json.Marshal(powPayload{
		Nonce: base64.RawURLEncoding.EncodeToString(nonce),
		Diff:  p.difficulty,
		Exp:   p.clock.Now().Add(PoWTTL).Unix(),
		Who:   p.who(addrKey),
	})
	enc := base64.RawURLEncoding.EncodeToString(payload)
	return enc + "." + base64.RawURLEncoding.EncodeToString(p.mac([]byte(enc))), p.difficulty
}

// Verify checks a solution once; a verified challenge cannot be used again.
func (p *PoW) Verify(addrKey, token, solution string) error {
	enc, sig, ok := strings.Cut(token, ".")
	if !ok || len(solution) == 0 || len(solution) > 32 {
		return ErrPoWInvalid
	}
	gotSig, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(gotSig, p.mac([]byte(enc))) {
		return ErrPoWInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		return ErrPoWInvalid
	}
	var pl powPayload
	if json.Unmarshal(raw, &pl) != nil || pl.Who != p.who(addrKey) {
		return ErrPoWInvalid
	}
	now := p.clock.Now()
	if now.Unix() > pl.Exp {
		return ErrPoWExpired
	}
	if LeadingZeroBits(sha256.Sum256([]byte(token+":"+solution))) < pl.Diff {
		return ErrPoWInvalid
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, exp := range p.used {
		if now.After(exp) {
			delete(p.used, k)
		}
	}
	if _, seen := p.used[pl.Nonce]; seen {
		return ErrPoWReused
	}
	p.used[pl.Nonce] = time.Unix(pl.Exp, 0)
	return nil
}

// LeadingZeroBits counts the leading zero bits of a hash.
func LeadingZeroBits(h [32]byte) int {
	n := 0
	for _, b := range h {
		if b == 0 {
			n += 8
			continue
		}
		return n + bits.LeadingZeros8(b)
	}
	return n
}
