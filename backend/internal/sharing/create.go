package sharing

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// CreateInput is POST /v1/sessions.
type CreateInput struct {
	Files           []FileInput `json:"files"`
	RequireApproval bool        `json:"require_approval"`
}

func cleanName(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '/' || r == '\\' {
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	if r := []rune(out); len(r) > 255 {
		out = string(r[:255])
	}
	return out
}

func validateFiles(in []FileInput) ([]FileInput, error) {
	if len(in) == 0 || len(in) > MaxFiles {
		if len(in) > MaxFiles {
			return nil, ErrOverLimit
		}
		return nil, ErrInvalid
	}
	var total int64
	out := make([]FileInput, 0, len(in))
	for _, f := range in {
		name := cleanName(f.Name)
		if name == "" || f.Size < 0 || len(f.Mime) > 255 {
			return nil, ErrInvalid
		}
		total += f.Size
		if total > MaxSessionBytes {
			return nil, ErrOverLimit
		}
		out = append(out, FileInput{Name: name, Size: f.Size, Mime: strings.TrimSpace(f.Mime)})
	}
	return out, nil
}

// Create starts a session owned by the caller's device with a fresh join window.
func (s *Service) Create(ctx context.Context, c Caller, in CreateInput) (SessionView, error) {
	files, err := validateFiles(in.Files)
	if err != nil {
		return SessionView{}, err
	}
	if ok, wait := s.cfg.Limits.CreateDevice.Allow(c.DeviceID); !ok {
		return SessionView{}, rateLimited("rate_limited", wait)
	}
	if ok, wait := s.cfg.Limits.CreateIP.Allow(c.IPKey); !ok {
		return SessionView{}, rateLimited("rate_limited", wait)
	}
	now := s.now()
	lifetime, maxOpen := GuestLifetime, GuestOpenSessions
	if c.SignedIn {
		lifetime, maxOpen = AccountLifetime, AcctOpenSessions
	}
	id := newID()
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		// Serialize session creation per device so the open-session cap cannot be raced.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "sessions:"+c.DeviceID); err != nil {
			return err
		}
		var open int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM share_sessions WHERE owner_device_id = $1::uuid AND status IN ('WAITING','ACTIVE') AND expires_at > $2`,
			c.DeviceID, now).Scan(&open); err != nil {
			return err
		}
		if open >= maxOpen {
			return ErrTooManyOpen
		}
		_, _, linkHash, err := s.insertSessionWithUniqueCode(ctx, tx, id, c, in.RequireApproval, now, lifetime)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO session_participants (id, session_id, device_id, role, status, display_name, platform, signed_in, created_at, joined_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, 'sender', 'JOINED', $4, $5, $6, $7, $7)`,
			newID(), id, c.DeviceID, c.DisplayName, c.Platform, c.SignedIn, now); err != nil {
			return err
		}
		for i, f := range files {
			if _, err := tx.Exec(ctx, `INSERT INTO shared_files (id, session_id, position, name, size, mime) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
				newID(), id, i, f.Name, f.Size, f.Mime); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO capability_tokens (token_hash, session_id, purpose, window_seq, via, created_at, expires_at)
			VALUES ($1, $2::uuid, 'join', 1, 'link', $3, $4)`, linkHash, id, now, now.Add(JoinWindow)); err != nil {
			return err
		}
		s.logEvent(ctx, tx, id, "SESSION_CREATED")
		return nil
	})
	if err != nil {
		return SessionView{}, err
	}
	return s.View(ctx, c.DeviceID, id)
}

// insertSessionWithUniqueCode inserts the session row, retrying with a new code when the code collides with
// another open join window (partial unique index). Each attempt runs in a savepoint.
func (s *Service) insertSessionWithUniqueCode(ctx context.Context, tx pgx.Tx, id string, c Caller, approval bool, now time.Time, lifetime time.Duration) (string, string, []byte, error) {
	linkToken, linkHash := newToken()
	for attempt := 0; attempt < 8; attempt++ {
		code := newCode()
		err := pgx.BeginFunc(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, `INSERT INTO share_sessions (id, owner_device_id, status, require_approval, join_window_state, join_window_seq,
				join_window_opened_at, join_window_ends_at, code_hmac, code_enc, link_enc, created_at, last_activity_at, expires_at)
				VALUES ($1::uuid, $2::uuid, 'WAITING', $3, 'OPEN', 1, $4, $5, $6, $7, $8, $4, $4, $9)`,
				id, c.DeviceID, approval, now, now.Add(JoinWindow), s.keys.codeHMAC(code), s.keys.seal(code), s.keys.seal(linkToken), now.Add(lifetime))
			return err
		})
		if isUniqueViolation(err) {
			continue
		}
		return code, linkToken, linkHash, err
	}
	return "", "", nil, errors.New("could not allocate a unique join code")
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}
