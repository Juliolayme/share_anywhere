package devices

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
)

var ctx = context.Background()

func TestCreateVerifyAndGeneratedName(t *testing.T) {
	f := newFixture(t, nil)
	s, err := f.svc.Create(ctx, "1.2.3.4", CreateInput{Transport: TransportCookie, Platform: "Web · Chrome"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(s.Device.DisplayName, "Web · Chrome · ") || s.Secret == "" || s.ExpiresIn != 900 {
		t.Fatalf("unexpected session %+v", s)
	}
	id, err := f.svc.Verify(ctx, s.AccessToken)
	if err != nil || id.DeviceID != s.Device.ID || id.AccountID != "" {
		t.Fatalf("verify: %+v %v", id, err)
	}
}

func TestCreateValidation(t *testing.T) {
	f := newFixture(t, nil)
	for _, in := range []CreateInput{
		{Platform: ""},
		{Platform: strings.Repeat("x", 61)},
		{Platform: "Web", DisplayName: strings.Repeat("n", 41)},
		{Platform: "\u200e\u0007"},
	} {
		if _, err := f.svc.Create(ctx, "a", in); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%+v: got %v", in, err)
		}
	}
	s, err := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: " Web ", DisplayName: "  My\u202e   laptop\n"})
	if err != nil || s.Device.DisplayName != "My laptop" || s.Device.Platform != "Web" {
		t.Fatalf("cleaning: %+v %v", s.Device, err)
	}
}

func TestProofOfWorkAboveSoftLimitThenHardLimit(t *testing.T) {
	f := newFixture(t, nil)
	for i := 0; i < 3; i++ {
		if _, err := f.svc.Create(ctx, "ip", CreateInput{Transport: TransportCookie, Platform: "Web"}); err != nil {
			t.Fatalf("create %d within the soft limit: %v", i, err)
		}
	}
	_, err := f.svc.Create(ctx, "ip", CreateInput{Transport: TransportCookie, Platform: "Web"})
	var pow *PoWRequiredError
	if !errors.As(err, &pow) || pow.Difficulty != testDifficulty {
		t.Fatalf("4th create should require proof of work, got %v", err)
	}
	// A wrong solution gets a fresh challenge, not a device.
	if _, err := f.svc.Create(ctx, "ip", CreateInput{Transport: TransportCookie, Platform: "Web", PoWToken: pow.Token, PoWSolution: "nope"}); !errors.As(err, &pow) {
		t.Fatalf("bad solution: %v", err)
	}
	// Each solved challenge admits one device until the hard limit of 10/hour.
	created := 3
	for created < 10 {
		tok, diff := f.pow.Challenge("ip")
		_, err := f.svc.Create(ctx, "ip", CreateInput{Transport: TransportCookie, Platform: "Web", PoWToken: tok, PoWSolution: solve(tok, diff)})
		if err != nil {
			// Earlier failed attempts above also spent hard-limit tokens.
			var rl *RateLimitedError
			if errors.As(err, &rl) {
				break
			}
			t.Fatalf("solved create: %v", err)
		}
		created++
	}
	tok, diff := f.pow.Challenge("ip")
	_, err = f.svc.Create(ctx, "ip", CreateInput{Transport: TransportCookie, Platform: "Web", PoWToken: tok, PoWSolution: solve(tok, diff)})
	var rl *RateLimitedError
	if !errors.As(err, &rl) || rl.Wait <= 0 {
		t.Fatalf("over the hard limit: want RateLimitedError, got %v", err)
	}
	// Another address is unaffected.
	if _, err := f.svc.Create(ctx, "other", CreateInput{Transport: TransportCookie, Platform: "Web"}); err != nil {
		t.Fatal(err)
	}
	// The limit refills over time.
	f.clk.Advance(time.Hour)
	if _, err := f.svc.Create(ctx, "ip", CreateInput{Transport: TransportCookie, Platform: "Web"}); err != nil {
		t.Fatalf("after an hour: %v", err)
	}
}

func TestRefreshRotationAndReuseRevokes(t *testing.T) {
	f := newFixture(t, nil)
	s0, _ := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: "Web"})
	f.clk.Advance(time.Minute)
	s1, err := f.svc.Refresh(ctx, s0.Secret)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Secret == s0.Secret || s1.Device.Generation != 1 || s1.Device.ID != s0.Device.ID {
		t.Fatalf("rotation: %+v", s1.Device)
	}
	s2, err := f.svc.Refresh(ctx, s1.Secret)
	if err != nil || s2.Device.Generation != 2 {
		t.Fatalf("second rotation: %v", err)
	}
	// Presenting the consumed s0 secret again revokes the device.
	if _, err := f.svc.Refresh(ctx, s0.Secret); !errors.Is(err, ErrSecretReused) {
		t.Fatalf("reuse: %v", err)
	}
	if _, err := f.svc.Refresh(ctx, s2.Secret); !errors.Is(err, ErrSecretUnknown) {
		t.Fatalf("the newest secret must die with the device: %v", err)
	}
	if _, err := f.svc.Verify(ctx, s2.AccessToken); !errors.Is(err, access.ErrTokenInvalid) {
		t.Fatalf("access token of a revoked device must fail immediately: %v", err)
	}
	if _, err := f.svc.Refresh(ctx, "unknown"); !errors.Is(err, ErrSecretUnknown) {
		t.Fatalf("unknown secret: %v", err)
	}
	if _, err := f.svc.Refresh(ctx, ""); !errors.Is(err, ErrSecretUnknown) {
		t.Fatalf("empty secret: %v", err)
	}
}

func TestRefreshRateLimitPerDevice(t *testing.T) {
	f := newFixture(t, nil)
	s, _ := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: "Web"})
	secret := s.Secret
	for i := 0; i < 60; i++ {
		n, err := f.svc.Refresh(ctx, secret)
		if err != nil {
			t.Fatalf("refresh %d: %v", i, err)
		}
		secret = n.Secret
	}
	_, err := f.svc.Refresh(ctx, secret)
	var rl *RateLimitedError
	if !errors.As(err, &rl) {
		t.Fatalf("61st refresh within an hour: %v", err)
	}
	// The secret was not consumed by the refused call.
	f.clk.Advance(2 * time.Minute)
	if _, err := f.svc.Refresh(ctx, secret); err != nil {
		t.Fatalf("after refill: %v", err)
	}
}

func TestRenameResetAndExpiry(t *testing.T) {
	f := newFixture(t, nil)
	s, _ := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: "Web"})
	d, err := f.svc.Rename(ctx, s.Device.ID, "Kitchen PC")
	if err != nil || d.DisplayName != "Kitchen PC" {
		t.Fatalf("rename: %v", err)
	}
	if _, err := f.svc.Rename(ctx, s.Device.ID, "   "); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty name: %v", err)
	}
	n, err := f.svc.Reset(ctx, s.Device.ID, "a")
	if err != nil || n.Device.ID == s.Device.ID || n.Device.Platform != "Web" {
		t.Fatalf("reset: %+v %v", n.Device, err)
	}
	if _, err := f.svc.Verify(ctx, s.AccessToken); err == nil {
		t.Fatal("old identity must be revoked after reset")
	}
	if _, err := f.svc.Refresh(ctx, s.Secret); err == nil {
		t.Fatal("old refresh secret must fail after reset")
	}
	if _, err := f.svc.Get(ctx, s.Device.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked device Get: %v", err)
	}
	// An unused identity expires after 30 days.
	f.clk.Advance(AnonymousLifetime + time.Minute)
	if _, err := f.svc.Refresh(ctx, n.Secret); !errors.Is(err, ErrDeviceInactive) {
		t.Fatalf("expired device refresh: %v", err)
	}
}

func TestPurge(t *testing.T) {
	f := newFixture(t, nil)
	stale, _ := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: "Web"})
	revoked, _ := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: "Web"})
	f.clk.Advance(29 * 24 * time.Hour)
	fresh, _ := f.svc.Create(ctx, "b", CreateInput{Transport: TransportCookie, Platform: "Web"})
	if _, err := f.svc.Reset(ctx, revoked.Device.ID, "c"); err != nil {
		t.Fatal(err)
	}
	f.clk.Advance(25 * time.Hour) // stale is now 30 days + 1 h unused; revoked was revoked 25 h ago
	n, err := f.svc.Purge(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("purged %d, want 2", n)
	}
	for _, id := range []string{stale.Device.ID, revoked.Device.ID} {
		if _, err := f.store.GetDevice(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s should be purged: %v", id, err)
		}
	}
	if _, err := f.store.GetDevice(ctx, fresh.Device.ID); err != nil {
		t.Fatalf("fresh device must survive: %v", err)
	}
}

func TestVerifyCachesButSeesLocalRevocation(t *testing.T) {
	f := newFixture(t, nil)
	s, _ := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: "Web"})
	if _, err := f.svc.Verify(ctx, s.AccessToken); err != nil {
		t.Fatal(err)
	}
	// Revocation by another instance (directly in the store) is seen once the 30 s cache entry ends.
	_ = f.store.RevokeDevice(ctx, s.Device.ID, f.clk.Now())
	f.clk.Advance(31 * time.Second)
	if _, err := f.svc.Verify(ctx, s.AccessToken); !errors.Is(err, access.ErrTokenInvalid) {
		t.Fatalf("after cache expiry: %v", err)
	}
}

func TestChallengeRateLimit(t *testing.T) {
	f := newFixture(t, nil)
	for i := 0; i < 30; i++ {
		if _, _, err := f.svc.Challenge("a"); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := f.svc.Challenge("a"); err == nil {
		t.Fatal("31st challenge in a minute must be limited")
	}
}

func TestGenerateNameAndCleanText(t *testing.T) {
	if n := GenerateName(strings.Repeat("P", 40)); len([]rune(n)) > 40 || strings.Contains(n, "PPPP") {
		t.Fatalf("long platform name: %q", n)
	}
	if got := CleanText("  a\t\tb\u200bc  "); got != "a bc" {
		t.Fatalf("got %q", got)
	}
}

func TestRefreshReuseGraceMem(t *testing.T) {
	testReuseGrace(t, nil)
}

// testReuseGrace: the immediately previous secret is accepted once within RefreshReuseGrace of its first
// use (the rotated cookie was lost); the lost secret is retired; every other reuse revokes the device.
func testReuseGrace(t *testing.T, store Store) {
	t.Helper()
	t.Run("lost cookie recovers once", func(t *testing.T) {
		f := newFixture(t, store)
		s0, _ := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: "Web"})
		lost, err := f.svc.Refresh(ctx, s0.Secret)
		if err != nil {
			t.Fatal(err)
		}
		f.clk.Advance(5 * time.Second)
		s2, err := f.svc.Refresh(ctx, s0.Secret)
		if err != nil || s2.Device.ID != s0.Device.ID || s2.Device.Generation != 2 {
			t.Fatalf("grace refresh: %+v %v", s2.Device, err)
		}
		// The same old secret a second time is reuse, even inside the window.
		if _, err := f.svc.Refresh(ctx, s0.Secret); !errors.Is(err, ErrSecretReused) {
			t.Fatalf("second grace use: %v", err)
		}
		if _, err := f.svc.Refresh(ctx, s2.Secret); !errors.Is(err, ErrSecretUnknown) {
			t.Fatalf("device must be revoked: %v", err)
		}
		_ = lost
	})
	t.Run("lost secret is retired", func(t *testing.T) {
		f := newFixture(t, store)
		s0, _ := f.svc.Create(ctx, "b", CreateInput{Transport: TransportCookie, Platform: "Web"})
		lost, _ := f.svc.Refresh(ctx, s0.Secret)
		s2, err := f.svc.Refresh(ctx, s0.Secret)
		if err != nil {
			t.Fatal(err)
		}
		f.clk.Advance(RefreshReuseGrace + time.Second)
		if _, err := f.svc.Refresh(ctx, lost.Secret); !errors.Is(err, ErrSecretReused) {
			t.Fatalf("retired secret after the window: %v", err)
		}
		if _, err := f.svc.Refresh(ctx, s2.Secret); !errors.Is(err, ErrSecretUnknown) {
			t.Fatalf("device must be revoked: %v", err)
		}
	})
	t.Run("retired secret inside the window is reuse", func(t *testing.T) {
		// QA P2-1: the lost secret was retired by the grace rotation; presenting it while still inside the
		// window must not count as grace (that would retire the live secret and keep two chains going).
		f := newFixture(t, store)
		s0, _ := f.svc.Create(ctx, "e", CreateInput{Transport: TransportCookie, Platform: "Web"})
		lost, _ := f.svc.Refresh(ctx, s0.Secret)
		f.clk.Advance(2 * time.Second)
		s2, err := f.svc.Refresh(ctx, s0.Secret)
		if err != nil {
			t.Fatal(err)
		}
		f.clk.Advance(2 * time.Second)
		if _, err := f.svc.Refresh(ctx, lost.Secret); !errors.Is(err, ErrSecretReused) {
			t.Fatalf("retired secret inside the window: %v", err)
		}
		if _, err := f.svc.Refresh(ctx, s2.Secret); !errors.Is(err, ErrSecretUnknown) {
			t.Fatalf("device must be revoked: %v", err)
		}
	})
	t.Run("after the window is reuse", func(t *testing.T) {
		f := newFixture(t, store)
		s0, _ := f.svc.Create(ctx, "c", CreateInput{Transport: TransportCookie, Platform: "Web"})
		s1, _ := f.svc.Refresh(ctx, s0.Secret)
		f.clk.Advance(RefreshReuseGrace + time.Second)
		if _, err := f.svc.Refresh(ctx, s0.Secret); !errors.Is(err, ErrSecretReused) {
			t.Fatalf("late reuse: %v", err)
		}
		if _, err := f.svc.Refresh(ctx, s1.Secret); !errors.Is(err, ErrSecretUnknown) {
			t.Fatalf("device must be revoked: %v", err)
		}
	})
	t.Run("two steps back is reuse", func(t *testing.T) {
		f := newFixture(t, store)
		s0, _ := f.svc.Create(ctx, "d", CreateInput{Transport: TransportCookie, Platform: "Web"})
		s1, _ := f.svc.Refresh(ctx, s0.Secret)
		s2, err := f.svc.Refresh(ctx, s1.Secret)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Refresh(ctx, s0.Secret); !errors.Is(err, ErrSecretReused) {
			t.Fatalf("older secret: %v", err)
		}
		if _, err := f.svc.Refresh(ctx, s2.Secret); !errors.Is(err, ErrSecretUnknown) {
			t.Fatalf("device must be revoked: %v", err)
		}
	})
}
