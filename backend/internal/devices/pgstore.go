package devices

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PGStore is the PostgreSQL Store. All SQL is parameterized.
type PGStore struct {
	pool *pgxpool.Pool
}

// NewPGStore returns a store backed by pool.
func NewPGStore(pool *pgxpool.Pool) *PGStore { return &PGStore{pool: pool} }

const deviceColumns = `id::text, kind, display_name, platform, refresh_transport, refresh_generation, created_at, last_seen_at, expires_at, revoked_at`

func scanDevice(row pgx.Row) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.Kind, &d.DisplayName, &d.Platform, &d.Transport, &d.Generation, &d.CreatedAt, &d.LastSeenAt, &d.ExpiresAt, &d.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	return d, err
}

func (s *PGStore) CreateDevice(ctx context.Context, d Device, secretHash []byte) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO devices (id, kind, display_name, platform, refresh_transport, refresh_generation, created_at, last_seen_at, expires_at)
			 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
			d.ID, d.Kind, d.DisplayName, d.Platform, d.Transport, d.Generation, d.CreatedAt, d.LastSeenAt, d.ExpiresAt); err != nil {
			return fmt.Errorf("insert device: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO device_refresh_secrets (secret_hash, device_id, generation, created_at) VALUES ($1, $2::uuid, $3, $4)`,
			secretHash, d.ID, d.Generation, d.CreatedAt); err != nil {
			return fmt.Errorf("insert refresh secret: %w", err)
		}
		return nil
	})
}

func (s *PGStore) SecretDevice(ctx context.Context, secretHash []byte) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT device_id::text FROM device_refresh_secrets WHERE secret_hash = $1`, secretHash).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrSecretUnknown
	}
	return id, err
}

func (s *PGStore) RotateSecret(ctx context.Context, oldHash, newHash []byte, now time.Time) (Device, error) {
	var out Device
	reused := false
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var deviceID string
		var generation int
		var usedAt *time.Time
		err := tx.QueryRow(ctx,
			`SELECT device_id::text, generation, used_at FROM device_refresh_secrets WHERE secret_hash = $1 FOR UPDATE`, oldHash,
		).Scan(&deviceID, &generation, &usedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSecretUnknown
		}
		if err != nil {
			return err
		}
		d, err := scanDevice(tx.QueryRow(ctx, `SELECT `+deviceColumns+` FROM devices WHERE id = $1::uuid FOR UPDATE`, deviceID))
		if err != nil {
			return err
		}
		if usedAt != nil && inReuseGrace(*usedAt, generation, d, now) {
			// The newer secret never reached the client: retire it and rotate again from this one.
			if _, err := tx.Exec(ctx,
				`UPDATE device_refresh_secrets SET used_at = $3 WHERE device_id = $1::uuid AND generation = $2 AND used_at IS NULL`,
				deviceID, d.Generation, now); err != nil {
				return err
			}
			usedAt = nil
		}
		if usedAt != nil {
			// Reuse of a consumed secret: revoke the device and drop its secrets (committed, then reported).
			if _, err := tx.Exec(ctx, `UPDATE devices SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1::uuid`, deviceID, now); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM device_refresh_secrets WHERE device_id = $1::uuid`, deviceID); err != nil {
				return err
			}
			reused = true
			return nil
		}
		if !d.Active(now) {
			return ErrDeviceInactive
		}
		// COALESCE keeps the first use time, so a grace rotation cannot extend the grace window.
		if _, err := tx.Exec(ctx, `UPDATE device_refresh_secrets SET used_at = COALESCE(used_at, $2) WHERE secret_hash = $1`, oldHash, now); err != nil {
			return err
		}
		out, err = scanDevice(tx.QueryRow(ctx,
			`UPDATE devices SET refresh_generation = refresh_generation + 1, last_seen_at = $2, expires_at = $3
			 WHERE id = $1::uuid RETURNING `+deviceColumns, deviceID, now, now.Add(LifetimeFor(d.Kind))))
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO device_refresh_secrets (secret_hash, device_id, generation, created_at) VALUES ($1, $2::uuid, $3, $4)`,
			newHash, deviceID, out.Generation, now)
		return err
	})
	if err != nil {
		return Device{}, err
	}
	if reused {
		return Device{}, ErrSecretReused
	}
	return out, nil
}

func (s *PGStore) GetDevice(ctx context.Context, id string) (Device, error) {
	return scanDevice(s.pool.QueryRow(ctx, `SELECT `+deviceColumns+` FROM devices WHERE id = $1::uuid`, id))
}

func (s *PGStore) RenameDevice(ctx context.Context, id, name string, now time.Time) (Device, error) {
	return scanDevice(s.pool.QueryRow(ctx,
		`UPDATE devices SET display_name = $2, last_seen_at = $3
		 WHERE id = $1::uuid AND revoked_at IS NULL AND expires_at > $3 RETURNING `+deviceColumns, id, name, now))
}

func (s *PGStore) RevokeDevice(ctx context.Context, id string, now time.Time) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE devices SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1::uuid`, id, now)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `DELETE FROM device_refresh_secrets WHERE device_id = $1::uuid`, id)
		return err
	})
}

func (s *PGStore) PurgeInactive(ctx context.Context, lastSeenBefore, revokedBefore time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM devices WHERE kind = 'anonymous' AND (last_seen_at < $1 OR revoked_at < $2)`, lastSeenBefore, revokedBefore)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
