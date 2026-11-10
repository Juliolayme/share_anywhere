package devices

import (
	"crypto/ed25519"
	"crypto/sha256"
	"io"
	"log/slog"
	"strconv"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

var t0 = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

const testDifficulty = 8

func testKey(seed byte) ed25519.PrivateKey {
	s := make([]byte, ed25519.SeedSize)
	for i := range s {
		s[i] = seed
	}
	return ed25519.NewKeyFromSeed(s)
}

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type fixture struct {
	clk    *clock.Fake
	store  Store
	tokens *Tokens
	pow    *PoW
	svc    *Service
}

func newFixture(t *testing.T, store Store) *fixture {
	t.Helper()
	clk := clock.NewFake(t0)
	if store == nil {
		store = NewMemStore()
	}
	tokens, err := NewTokens(map[string]ed25519.PrivateKey{"k1": testKey(1), "k0": testKey(2)}, "k1", clk)
	if err != nil {
		t.Fatal(err)
	}
	pow := NewPoW([]byte("0123456789abcdef0123456789abcdef"), testDifficulty, clk)
	return &fixture{clk: clk, store: store, tokens: tokens, pow: pow,
		svc: NewService(store, tokens, pow, clk, DefaultLimits(clk), discard())}
}

// solve brute-forces a proof-of-work solution (difficulty 8 takes ~256 hashes).
func solve(token string, difficulty int) string {
	for i := 0; ; i++ {
		s := strconv.Itoa(i)
		if LeadingZeroBits(sha256.Sum256([]byte(token+":"+s))) >= difficulty {
			return s
		}
	}
}

func sha256Sum(s string) [32]byte { return sha256.Sum256([]byte(s)) }
