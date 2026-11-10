package devices

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

// AccessTokenTTL is the lifetime of a device access token (docs/SECURITY_MODEL.md §4).
const AccessTokenTTL = 15 * time.Minute

const issuer = "share-anywhere"

// claims is the JWT payload: sub = device ID, typ = "device", gen = refresh generation.
// acct and dl are added by the account layer in Phase 5A.
type claims struct {
	Typ  string `json:"typ"`
	Gen  int    `json:"gen"`
	Acct string `json:"acct,omitempty"`
	DL   bool   `json:"dl,omitempty"`
	jwt.RegisteredClaims
}

// Tokens issues and verifies EdDSA (Ed25519) access tokens. Only EdDSA is accepted.
type Tokens struct {
	keys   map[string]ed25519.PrivateKey
	active string
	clock  clock.Clock
}

// NewTokens returns a token service signing with keys[active].
func NewTokens(keys map[string]ed25519.PrivateKey, active string, c clock.Clock) (*Tokens, error) {
	if _, ok := keys[active]; !ok {
		return nil, fmt.Errorf("active key %q not found", active)
	}
	return &Tokens{keys: keys, active: active, clock: c}, nil
}

// Issue signs an access token for a device.
func (t *Tokens) Issue(deviceID string, generation int) (string, error) {
	now := t.clock.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims{
		Typ: "device",
		Gen: generation,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   deviceID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(AccessTokenTTL)),
		},
	})
	tok.Header["kid"] = t.active
	return tok.SignedString(t.keys[t.active])
}

// Parse verifies signature, algorithm, issuer, type, and expiry.
func (t *Tokens) Parse(raw string) (access.Identity, error) {
	var c claims
	_, err := jwt.ParseWithClaims(raw, &c, func(tok *jwt.Token) (any, error) {
		kid, _ := tok.Header["kid"].(string)
		key, ok := t.keys[kid]
		if !ok {
			return nil, errors.New("unknown kid")
		}
		return key.Public(), nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuer(issuer),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithTimeFunc(t.clock.Now),
	)
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return access.Identity{}, access.ErrTokenExpired
		}
		return access.Identity{}, access.ErrTokenInvalid
	}
	if c.Typ != "device" || c.Subject == "" {
		return access.Identity{}, access.ErrTokenInvalid
	}
	return access.Identity{DeviceID: c.Subject, Generation: c.Gen, AccountID: c.Acct, DeviceAdded: c.DL}, nil
}
