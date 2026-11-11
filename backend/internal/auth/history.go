package auth

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
)

// Encrypted cloud history (PRD §2 History, §7.5). Entries are AES-256-GCM ciphertext under the ADK's
// history-v1 subkey; the server sees only sizes, versions, and timestamps.

// historyLockClass namespaces the per-user advisory lock (pg_advisory_xact_lock(class, hashtext(user_id)));
// clipboard (Phase 5B) uses another class so the two sequences never wait on each other.
const historyLockClass = 1

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	_, err := uuid.Parse(s)
	return err == nil
}

// EntryInput is POST /v1/history/entries.
type EntryInput struct {
	EntryID    string `json:"entry_id"`
	KeyVersion int    `json:"key_version"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// Entry is one history entry or tombstone.
type Entry struct {
	EntryID        string    `json:"entry_id"`
	Seq            int64     `json:"seq"`
	KeyVersion     int       `json:"key_version"`
	Nonce          *string   `json:"nonce,omitempty"`
	Ciphertext     *string   `json:"ciphertext,omitempty"`
	OriginDeviceID string    `json:"origin_device_id"`
	CreatedAt      time.Time `json:"created_at"`
	Deleted        bool      `json:"deleted"`
}

// EntryPage is GET /v1/history/entries.
type EntryPage struct {
	Entries   []Entry `json:"entries"`
	NextAfter int64   `json:"next_after"`
}

func lockHistory(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, historyLockClass, userID); err != nil {
		return 0, err
	}
	var maxSeq int64
	err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) FROM history_entries WHERE user_id = $1::uuid`, userID).Scan(&maxSeq)
	return maxSeq, err
}

// AddEntry stores an encrypted entry and returns its seq. Repeating an entry_id returns the original seq and
// changes nothing (idempotent retries from an offline queue). A new entry must be encrypted under the
// account's current key version (409 key_version_conflict otherwise, nothing stored).
func (s *Service) AddEntry(ctx context.Context, id access.Identity, in EntryInput) (int64, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return 0, err
	}
	nonce, ok1 := b64(in.Nonce)
	ct, ok2 := b64(in.Ciphertext)
	if !isUUID(in.EntryID) || in.KeyVersion < 1 || !ok1 || len(nonce) != nonceLen || !ok2 || len(ct) < 16 || len(ct) > maxCiphertext {
		return 0, ErrInvalid
	}
	if err := allow(s.cfg.Limits.HistoryWrite, se.DeviceID); err != nil {
		return 0, err
	}
	entryID, _ := uuid.Parse(in.EntryID)
	var seq int64
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT seq FROM history_entries WHERE user_id = $1::uuid AND entry_id = $2`, se.UserID, entryID).Scan(&seq)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// New entries must use the current key (docs/ADR/0015-authenticated-recovery-key.md): a device that
		// missed a rotation gets 409 key_version_conflict, picks up the new key, and retries. FOR SHARE holds
		// off a concurrent rotation (which locks the row FOR UPDATE) until this entry is stored.
		var current int
		if err := tx.QueryRow(ctx, `SELECT key_version FROM account_keys WHERE user_id = $1::uuid FOR SHARE`, se.UserID).Scan(&current); err != nil {
			return err
		}
		if err := s.checkLiveSession(ctx, tx, se); err != nil {
			return err
		}
		if in.KeyVersion != current {
			return ErrKeyVersion
		}
		maxSeq, err := lockHistory(ctx, tx, se.UserID)
		if err != nil {
			return err
		}
		// Re-check under the lock: a concurrent retry of the same entry may have committed meanwhile.
		err = tx.QueryRow(ctx, `SELECT seq FROM history_entries WHERE user_id = $1::uuid AND entry_id = $2`, se.UserID, entryID).Scan(&seq)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		seq = maxSeq + 1
		_, err = tx.Exec(ctx,
			`INSERT INTO history_entries (user_id, entry_id, seq, origin_device_id, key_version, nonce, ciphertext, created_at)
			 VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8)`,
			se.UserID, entryID, seq, se.DeviceID, in.KeyVersion, nonce, ct, s.cfg.Clock.Now())
		return err
	})
	return seq, err
}

// Entries pages through entries and tombstones with seq > after, in seq order. Because seq is assigned under
// the per-user lock and committed in order, a reader that resumes from next_after never skips or repeats.
func (s *Service) Entries(ctx context.Context, id access.Identity, after int64, limit int) (EntryPage, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return EntryPage{}, err
	}
	rows, err := s.cfg.Pool.Query(ctx,
		`SELECT entry_id::text, seq, key_version, nonce, ciphertext, origin_device_id::text, created_at, deleted_at IS NOT NULL
		   FROM history_entries WHERE user_id = $1::uuid AND seq > $2 ORDER BY seq LIMIT $3`, se.UserID, after, limit)
	if err != nil {
		return EntryPage{}, err
	}
	defer rows.Close()
	page := EntryPage{Entries: []Entry{}, NextAfter: after}
	for rows.Next() {
		var e Entry
		var nonce, ct []byte
		if err := rows.Scan(&e.EntryID, &e.Seq, &e.KeyVersion, &nonce, &ct, &e.OriginDeviceID, &e.CreatedAt, &e.Deleted); err != nil {
			return EntryPage{}, err
		}
		if !e.Deleted {
			n, c := enc(nonce), enc(ct)
			e.Nonce, e.Ciphertext = &n, &c
		}
		e.CreatedAt = e.CreatedAt.UTC()
		page.Entries = append(page.Entries, e)
		page.NextAfter = e.Seq
	}
	return page, rows.Err()
}

// DeleteEntry turns an entry into a tombstone with a new seq so other devices learn of the deletion.
// Deleting a tombstone again changes nothing.
func (s *Service) DeleteEntry(ctx context.Context, id access.Identity, entryID string) error {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return err
	}
	if !isUUID(entryID) {
		return ErrNotFound
	}
	if err := allow(s.cfg.Limits.HistoryWrite, se.DeviceID); err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		maxSeq, err := lockHistory(ctx, tx, se.UserID)
		if err != nil {
			return err
		}
		var deleted bool
		err = tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM history_entries WHERE user_id = $1::uuid AND entry_id = $2::uuid`,
			se.UserID, entryID).Scan(&deleted)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil || deleted {
			return err
		}
		_, err = tx.Exec(ctx,
			`UPDATE history_entries SET seq = $3, deleted_at = $4, nonce = NULL, ciphertext = NULL
			  WHERE user_id = $1::uuid AND entry_id = $2::uuid`, se.UserID, entryID, maxSeq+1, s.cfg.Clock.Now())
		return err
	})
}

// ClearHistory tombstones every live entry of the account, each with a new seq.
func (s *Service) ClearHistory(ctx context.Context, id access.Identity) error {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return err
	}
	if err := allow(s.cfg.Limits.HistoryWrite, se.DeviceID); err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		maxSeq, err := lockHistory(ctx, tx, se.UserID)
		if err != nil {
			return err
		}
		// New seqs start above every existing one, so the UNIQUE (user_id, seq) check never collides.
		_, err = tx.Exec(ctx,
			`UPDATE history_entries h SET seq = $2 + o.rn, deleted_at = $3, nonce = NULL, ciphertext = NULL
			   FROM (SELECT entry_id, row_number() OVER (ORDER BY seq) AS rn FROM history_entries
			          WHERE user_id = $1::uuid AND deleted_at IS NULL) o
			  WHERE h.user_id = $1::uuid AND h.entry_id = o.entry_id`, se.UserID, maxSeq, s.cfg.Clock.Now())
		return err
	})
}
