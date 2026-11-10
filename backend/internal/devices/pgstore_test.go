package devices

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/migrations"
)

// newPGStore runs the migrations in a fresh schema of TEST_DATABASE_URL (CI service container).
func newPGStore(t *testing.T) *PGStore {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	schema := "t_" + hex.EncodeToString(b)
	admin, err := db.Open(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})
	applied, err := db.Migrate(context.Background(), pool, migrations.FS)
	if err != nil || len(applied) == 0 {
		t.Fatalf("migrate: %v %v", applied, err)
	}
	// A second run applies nothing.
	if again, err := db.Migrate(context.Background(), pool, migrations.FS); err != nil || len(again) != 0 {
		t.Fatalf("second migrate: %v %v", again, err)
	}
	return NewPGStore(pool)
}

func TestPGStoreLifecycle(t *testing.T) {
	store := newPGStore(t)
	f := newFixture(t, store)
	s0, err := f.svc.Create(ctx, "a", CreateInput{Platform: "Web", DisplayName: "Desk"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Verify(ctx, s0.AccessToken); err != nil {
		t.Fatal(err)
	}
	s1, err := f.svc.Refresh(ctx, s0.Secret)
	if err != nil || s1.Device.Generation != 1 {
		t.Fatalf("refresh: %v", err)
	}
	if d, err := f.svc.Rename(ctx, s1.Device.ID, "Sofa"); err != nil || d.DisplayName != "Sofa" {
		t.Fatalf("rename: %v", err)
	}
	if _, err := f.svc.Refresh(ctx, s0.Secret); !errors.Is(err, ErrSecretReused) {
		t.Fatalf("reuse: %v", err)
	}
	d, err := store.GetDevice(ctx, s0.Device.ID)
	if err != nil || d.RevokedAt == nil {
		t.Fatalf("device must be revoked after reuse: %+v %v", d, err)
	}
	if _, err := f.svc.Refresh(ctx, s1.Secret); !errors.Is(err, ErrSecretUnknown) {
		t.Fatalf("secrets deleted on reuse: %v", err)
	}
	if _, err := store.GetDevice(ctx, "00000000-0000-4000-8000-000000000000"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing device: %v", err)
	}
	if err := store.RevokeDevice(ctx, "00000000-0000-4000-8000-000000000000", t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoke missing: %v", err)
	}

	// Reset and purge.
	s2, _ := f.svc.Create(ctx, "b", CreateInput{Platform: "Web"})
	n, err := f.svc.Reset(ctx, s2.Device.ID, "b")
	if err != nil {
		t.Fatal(err)
	}
	f.clk.Advance(25 * time.Hour)
	purged, err := f.svc.Purge(ctx)
	if err != nil || purged != 2 { // s0 (revoked by reuse) and s2 (revoked by reset)
		t.Fatalf("purge: %d %v", purged, err)
	}
	if _, err := store.GetDevice(ctx, n.Device.ID); err != nil {
		t.Fatalf("new identity must survive: %v", err)
	}
	f.clk.Advance(AnonymousLifetime)
	if _, err := f.svc.Refresh(ctx, n.Secret); !errors.Is(err, ErrDeviceInactive) {
		t.Fatalf("expired: %v", err)
	}
	if purged, _ := f.svc.Purge(ctx); purged != 1 {
		t.Fatalf("inactive purge: %d", purged)
	}
}

// TestPGStoreConcurrentRefresh: two refreshes racing with the same secret cannot both succeed;
// the loser is treated as reuse and the device is revoked.
func TestPGStoreConcurrentRefresh(t *testing.T) {
	store := newPGStore(t)
	f := newFixture(t, store)
	s, _ := f.svc.Create(ctx, "a", CreateInput{Platform: "Web"})
	var wg sync.WaitGroup
	results := make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = f.svc.Refresh(ctx, s.Secret)
		}(i)
	}
	wg.Wait()
	ok := 0
	for _, err := range results {
		if err == nil {
			ok++
		} else if !errors.Is(err, ErrSecretReused) {
			t.Fatalf("unexpected error %v", err)
		}
	}
	if ok != 1 {
		t.Fatalf("exactly one refresh must win, got %d (%v)", ok, results)
	}
}
