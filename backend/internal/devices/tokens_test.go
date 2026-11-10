package devices

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

func TestTokenRoundTrip(t *testing.T) {
	f := newFixture(t, nil)
	raw, err := f.tokens.Issue("dev-1", 3)
	if err != nil {
		t.Fatal(err)
	}
	id, err := f.tokens.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if id.DeviceID != "dev-1" || id.Generation != 3 || id.AccountID != "" || id.DeviceAdded {
		t.Fatalf("unexpected identity %+v", id)
	}
	hdr, _ := base64.RawURLEncoding.DecodeString(strings.Split(raw, ".")[0])
	if !strings.Contains(string(hdr), `"alg":"EdDSA"`) || !strings.Contains(string(hdr), `"kid":"k1"`) {
		t.Fatalf("header %s", hdr)
	}
}

func TestTokenRejections(t *testing.T) {
	f := newFixture(t, nil)
	good, _ := f.tokens.Issue("dev-1", 0)

	sign := func(method jwt.SigningMethod, key any, kid string, c claims) string {
		tok := jwt.NewWithClaims(method, c)
		if kid != "" {
			tok.Header["kid"] = kid
		}
		s, err := tok.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	base := claims{Typ: "device", RegisteredClaims: jwt.RegisteredClaims{
		Issuer: issuer, Subject: "dev-1", IssuedAt: jwt.NewNumericDate(t0), ExpiresAt: jwt.NewNumericDate(t0.Add(time.Minute)),
	}}

	// HS256 signed with the public key bytes: the classic algorithm-confusion attack.
	pub := testKey(1).Public().(ed25519.PublicKey)
	hs := sign(jwt.SigningMethodHS256, []byte(pub), "k1", base)
	unknownKid := sign(jwt.SigningMethodEdDSA, testKey(1), "nope", base)
	otherKey := sign(jwt.SigningMethodEdDSA, testKey(9), "k1", base)
	wrongIss := base
	wrongIss.Issuer = "someone-else"
	wrongTyp := base
	wrongTyp.Typ = "account"
	noExp := base
	noExp.ExpiresAt = nil

	parts := strings.Split(good, ".")
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"device","sub":"dev-2","iss":"share-anywhere","exp":9999999999,"iat":1}`)) + "." + parts[2]

	cases := map[string]string{
		"hs256 confusion": hs,
		"unknown kid":     unknownKid,
		"wrong key":       otherKey,
		"wrong issuer":    sign(jwt.SigningMethodEdDSA, testKey(1), "k1", wrongIss),
		"wrong typ":       sign(jwt.SigningMethodEdDSA, testKey(1), "k1", wrongTyp),
		"no exp":          sign(jwt.SigningMethodEdDSA, testKey(1), "k1", noExp),
		"tampered claims": tampered,
		"alg none":        parts[0][:0] + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + parts[1] + ".",
		"garbage":         "not.a.jwt",
		"empty":           "",
	}
	for name, raw := range cases {
		if _, err := f.tokens.Parse(raw); !errors.Is(err, access.ErrTokenInvalid) {
			t.Errorf("%s: want ErrTokenInvalid, got %v", name, err)
		}
	}
}

func TestTokenExpiryAndKeyRotation(t *testing.T) {
	f := newFixture(t, nil)
	raw, _ := f.tokens.Issue("dev-1", 0)
	f.clk.Advance(AccessTokenTTL + time.Second)
	if _, err := f.tokens.Parse(raw); !errors.Is(err, access.ErrTokenExpired) {
		t.Fatalf("want ErrTokenExpired, got %v", err)
	}

	// A token signed by the previous key (k0) still verifies while k0 is configured.
	clk := clock.NewFake(t0)
	old, _ := NewTokens(map[string]ed25519.PrivateKey{"k0": testKey(2)}, "k0", clk)
	oldTok, _ := old.Issue("dev-1", 0)
	cur, _ := NewTokens(map[string]ed25519.PrivateKey{"k1": testKey(1), "k0": testKey(2)}, "k1", clk)
	if _, err := cur.Parse(oldTok); err != nil {
		t.Fatalf("token from a configured older kid should verify: %v", err)
	}
	// Once k0 is removed, its tokens are rejected.
	removed, _ := NewTokens(map[string]ed25519.PrivateKey{"k1": testKey(1)}, "k1", clk)
	if _, err := removed.Parse(oldTok); !errors.Is(err, access.ErrTokenInvalid) {
		t.Fatalf("token from a removed kid must fail: %v", err)
	}
	if _, err := NewTokens(map[string]ed25519.PrivateKey{"k1": testKey(1)}, "missing", clk); err == nil {
		t.Fatal("unknown active kid must fail")
	}
}
