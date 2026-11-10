package db

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

// Migrate applies every pending migration in fsys with goose (ADR 0007) and returns the
// versions applied in this call.
func Migrate(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS) ([]int64, error) {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }()
	return migrateDB(ctx, sqlDB, fsys)
}

func migrateDB(ctx context.Context, sqlDB *sql.DB, fsys fs.FS) ([]int64, error) {
	// The advisory-lock session locker serializes concurrent starts so no migration runs twice.
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, fmt.Errorf("migration lock: %w", err)
	}
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, fsys, goose.WithSessionLocker(locker))
	if err != nil {
		return nil, fmt.Errorf("migrations: %w", err)
	}
	results, err := p.Up(ctx)
	if err != nil {
		return nil, fmt.Errorf("apply migrations: %w", err)
	}
	applied := make([]int64, 0, len(results))
	for _, r := range results {
		applied = append(applied, r.Source.Version)
	}
	return applied, nil
}
