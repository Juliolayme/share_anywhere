package devices

import (
	"errors"
	"testing"
)

func TestPoWVerify(t *testing.T) {
	f := newFixture(t, nil)
	tok, diff := f.pow.Challenge("1.2.3.4")
	if diff != testDifficulty {
		t.Fatalf("difficulty %d", diff)
	}
	sol := solve(tok, diff)
	if err := f.pow.Verify("5.6.7.8", tok, sol); !errors.Is(err, ErrPoWInvalid) {
		t.Fatalf("challenge must be bound to the address: %v", err)
	}
	if err := f.pow.Verify("1.2.3.4", tok, sol); err != nil {
		t.Fatalf("valid solution rejected: %v", err)
	}
	if err := f.pow.Verify("1.2.3.4", tok, sol); !errors.Is(err, ErrPoWReused) {
		t.Fatalf("solution reuse must fail: %v", err)
	}
}

func TestPoWRejectsBadInput(t *testing.T) {
	f := newFixture(t, nil)
	tok, diff := f.pow.Challenge("a")
	sol := solve(tok, diff)
	// Find a solution that does not meet the difficulty.
	bad := "x"
	for i := 0; LeadingZeroBits(sha256Sum(tok+":"+bad)) >= diff; i++ {
		bad = "x" + string(rune('a'+i))
	}
	for name, tc := range map[string][2]string{
		"wrong solution": {tok, bad},
		"empty solution": {tok, ""},
		"long solution":  {tok, "0123456789012345678901234567890123"},
		"no signature":   {"abc", sol},
		"bad signature":  {tok[:len(tok)-2] + "AA", sol},
	} {
		if err := f.pow.Verify("a", tc[0], tc[1]); !errors.Is(err, ErrPoWInvalid) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	f.clk.Advance(PoWTTL + 1e9)
	if err := f.pow.Verify("a", tok, sol); !errors.Is(err, ErrPoWExpired) {
		t.Fatalf("expired challenge: %v", err)
	}
}

func TestLeadingZeroBits(t *testing.T) {
	var h [32]byte
	if LeadingZeroBits(h) != 256 {
		t.Fatal("all zero")
	}
	h[1] = 0x10
	if got := LeadingZeroBits(h); got != 11 {
		t.Fatalf("got %d", got)
	}
}
