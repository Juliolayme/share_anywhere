// Package clipboard implements Clipboard Sync v1 (Phase 5B; PRD §7, docs/API.md §2.5,
// docs/CLIPBOARD_PROTOCOL.md): immutable end-to-end encrypted text events with a per-user seq cursor,
// tombstones, the 100-item cap and retention sweep, per-device cursors, account clipboard settings, and
// metadata-only WebSocket notifications. Every endpoint is account+device; the server stores ciphertext only.
package clipboard

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/auth"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
)

// Limits (PRD §7.6, docs/SECURITY_MODEL.md §5).
const (
	// MaxPayload is the largest plaintext (UTF-8 bytes) an event may declare.
	MaxPayload = 256 << 10
	// MaxCiphertext is MaxPayload plus the 16-byte AES-GCM tag.
	MaxCiphertext = MaxPayload + 16
	// MaxLive is the number of live events kept per account; the oldest is tombstoned beyond it.
	MaxLive = 100
	// DefaultRetentionDays applies until the account changes it (1..7).
	DefaultRetentionDays = 7
	// TombstoneTTL is how long the sweep keeps tombstones so offline devices learn of deletions.
	TombstoneTTL = 7 * 24 * time.Hour

	nonceLen     = 12
	tagLen       = 16
	eventType    = "TEXT"
	mimeType     = "text/plain"
	maxPageLimit = 200
	maxHistLimit = 100
	defaultLimit = 100
	// notifyTimeout bounds the recipient and presence lookups behind a WebSocket notification.
	notifyTimeout = 5 * time.Second
)

// lockClass namespaces the per-user advisory lock (pg_advisory_xact_lock(class, hashtext(user_id))); history
// uses class 1 (internal/auth), so the two sequences never wait on each other.
const lockClass = 2

// Accounts is the account layer this package builds on (implemented by *auth.Service).
type Accounts interface {
	// RequireAdded returns the caller's live account session of an added device.
	RequireAdded(ctx context.Context, id access.Identity) (auth.Caller, error)
	// HoldKeys holds the account_keys row FOR SHARE in tx, re-checks the caller's session, and returns the
	// account's current key version.
	HoldKeys(ctx context.Context, tx pgx.Tx, c auth.Caller) (int, error)
}

// Notifier delivers WebSocket events to a device's open sockets (implemented by *ws.Hub).
type Notifier interface {
	SendToDevice(deviceID string, v any) bool
}

// Limits are the clipboard rate limits (docs/SECURITY_MODEL.md §5).
type Limits struct {
	CreateDevice  *ratelimit.Limiter // event creation per device
	CreateAccount *ratelimit.Limiter // event creation per account
	Write         *ratelimit.Limiter // deletions, clear, settings changes per device
	Read          *ratelimit.Limiter // GET /v1/clipboard/events and /v1/clipboard/history per device
}

// ScaledLimits returns the defaults multiplied by m (test stacks only; config allows m > 1 only with
// SA_ENV=test).
func ScaledLimits(c clock.Clock, m int) Limits {
	if m < 1 {
		m = 1
	}
	r := func(n int) *ratelimit.Limiter {
		return ratelimit.New(ratelimit.Rule{Limit: n * m, Window: time.Minute}, c)
	}
	return Limits{CreateDevice: r(60), CreateAccount: r(240), Write: r(600), Read: r(600)}
}

// Config wires the service.
type Config struct {
	Pool     *pgxpool.Pool
	Clock    clock.Clock
	Accounts Accounts
	Notify   Notifier
	Limits   Limits
	Log      *slog.Logger
}

// Service implements the clipboard operations.
type Service struct{ cfg Config }

// New returns the clipboard service.
func New(cfg Config) *Service {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &Service{cfg: cfg}
}

func errf(status int, code, msg string) *auth.Error {
	return &auth.Error{Status: status, Code: code, Msg: msg}
}

// Documented clipboard errors (docs/API.md §3); account errors come from internal/auth.
var (
	ErrInvalid    = auth.ErrInvalid
	ErrNotFound   = auth.ErrNotFound
	ErrKeyVersion = auth.ErrKeyVersion
	ErrPaused     = errf(http.StatusConflict, "clipboard_paused", "Clipboard Sync is paused for this account. Resume it to sync new items.")
	ErrTooLarge   = errf(http.StatusRequestEntityTooLarge, "payload_too_large", "Clipboard items can be at most 256 KB.")
)

func rateLimited(wait time.Duration) *auth.Error {
	return &auth.Error{Status: http.StatusTooManyRequests, Code: "rate_limited", Msg: "Too many attempts. Try again later.", Wait: wait}
}

func allow(l *ratelimit.Limiter, key string) error {
	if ok, wait := l.Allow(key); !ok {
		return rateLimited(wait)
	}
	return nil
}

func b64(s string) ([]byte, bool) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	return b, err == nil
}

func enc(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// EventInput is POST /v1/clipboard/events.
type EventInput struct {
	EventID     string `json:"event_id"`
	KeyVersion  int    `json:"key_version"`
	Nonce       string `json:"nonce"`
	Ciphertext  string `json:"ciphertext"`
	PayloadSize int    `json:"payload_size"`
	EventType   string `json:"event_type,omitempty"`
	MimeType    string `json:"mime_type,omitempty"`
}

// Created is the 201 answer to POST /v1/clipboard/events.
type Created struct {
	Seq       int64     `json:"seq"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Event is one clipboard event or tombstone.
type Event struct {
	EventID        string    `json:"event_id"`
	Seq            int64     `json:"seq"`
	OriginDeviceID string    `json:"origin_device_id"`
	EventType      string    `json:"event_type"`
	MimeType       string    `json:"mime_type"`
	KeyVersion     int       `json:"key_version"`
	Nonce          *string   `json:"nonce"`
	Ciphertext     *string   `json:"ciphertext"`
	PayloadSize    int       `json:"payload_size"`
	CreatedAt      time.Time `json:"created_at"`
	ExpiresAt      time.Time `json:"expires_at"`
	Deleted        bool      `json:"deleted"`
}

// EventPage is GET /v1/clipboard/events.
type EventPage struct {
	Events     []Event `json:"events"`
	NextCursor int64   `json:"next_cursor"`
}

// HistoryPage is GET /v1/clipboard/history.
type HistoryPage struct {
	Events []Event `json:"events"`
	Cursor int64   `json:"cursor"`
}

// Settings are the account's clipboard settings.
type Settings struct {
	Paused        bool `json:"paused"`
	RetentionDays int  `json:"retention_days"`
	SensitiveSkip bool `json:"sensitive_skip"`
}

// DefaultSettings apply until the account stores its own.
var DefaultSettings = Settings{Paused: false, RetentionDays: DefaultRetentionDays, SensitiveSkip: true}

// WebSocket events (shared/protocol/websocket-events.json). Metadata only: never ciphertext or plaintext.
type (
	eventCreatedMsg struct {
		Type           string    `json:"type"`
		EventID        string    `json:"event_id"`
		Seq            int64     `json:"seq"`
		OriginDeviceID string    `json:"origin_device_id"`
		CreatedAt      time.Time `json:"created_at"`
		PayloadSize    int       `json:"payload_size"`
		KeyVersion     int       `json:"key_version"`
	}
	eventDeletedMsg struct {
		Type    string `json:"type"`
		EventID string `json:"event_id"`
		Seq     int64  `json:"seq"`
	}
	historyClearedMsg struct {
		Type string `json:"type"`
		Seq  int64  `json:"seq"`
	}
	settingsUpdatedMsg struct {
		Type string `json:"type"`
		Settings
	}
	deviceMsg struct {
		Type     string `json:"type"`
		DeviceID string `json:"device_id"`
	}
)

// lock takes the account's clipboard advisory lock for the rest of tx; it must come before HoldKeys
// (lock order: clipboard advisory lock → account_keys FOR SHARE → live-session check).
func lock(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, lockClass, userID)
	return err
}

// settingsForUpdate returns the account's settings and last assigned seq, creating the defaults row if needed,
// and locks the row until tx ends. Call it only under the clipboard advisory lock.
func (s *Service) settingsForUpdate(ctx context.Context, tx pgx.Tx, userID string) (Settings, int64, error) {
	if _, err := tx.Exec(ctx, `INSERT INTO clipboard_settings (user_id, updated_at) VALUES ($1::uuid, $2) ON CONFLICT (user_id) DO NOTHING`,
		userID, s.cfg.Clock.Now()); err != nil {
		return Settings{}, 0, err
	}
	var st Settings
	var last int64
	err := tx.QueryRow(ctx, `SELECT paused, retention_days, sensitive_skip, last_seq FROM clipboard_settings WHERE user_id = $1::uuid FOR UPDATE`,
		userID).Scan(&st.Paused, &st.RetentionDays, &st.SensitiveSkip, &last)
	return st, last, err
}

func setLastSeq(ctx context.Context, tx pgx.Tx, userID string, last int64) error {
	_, err := tx.Exec(ctx, `UPDATE clipboard_settings SET last_seq = $2 WHERE user_id = $1::uuid`, userID, last)
	return err
}

// Create stores an encrypted event and returns its seq. Repeating an event_id returns the stored seq and
// changes nothing (offline retries; a deleted event is not restored). A new event needs the account's current
// key version (409 key_version_conflict) and an unpaused account (409 clipboard_paused); nothing is stored
// otherwise. Inserting beyond MaxLive live events tombstones the oldest one in the same transaction. The
// ciphertext must be exactly payload_size plus the 16-byte AES-GCM tag (v1 encrypts the text as is), else 400.
func (s *Service) Create(ctx context.Context, id access.Identity, in EventInput) (Created, error) {
	c, err := s.cfg.Accounts.RequireAdded(ctx, id)
	if err != nil {
		return Created{}, err
	}
	nonce, okN := b64(in.Nonce)
	ct, okC := b64(in.Ciphertext)
	if in.PayloadSize > MaxPayload || (okC && len(ct) > MaxCiphertext) {
		return Created{}, ErrTooLarge
	}
	if in.EventType == "" {
		in.EventType = eventType
	}
	if in.MimeType == "" {
		in.MimeType = mimeType
	}
	if !auth.IsCanonicalUUID(in.EventID) || in.KeyVersion < 1 || !okN || len(nonce) != nonceLen || !okC || len(ct) < tagLen+1 ||
		in.PayloadSize < 1 || len(ct) != in.PayloadSize+tagLen || in.EventType != eventType || in.MimeType != mimeType {
		return Created{}, ErrInvalid
	}
	if err := allow(s.cfg.Limits.CreateDevice, c.DeviceID); err != nil {
		return Created{}, err
	}
	if err := allow(s.cfg.Limits.CreateAccount, c.UserID); err != nil {
		return Created{}, err
	}
	eventID, _ := uuid.Parse(in.EventID)
	var out Created
	var capped []eventDeletedMsg
	fresh := false
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		capped, fresh = nil, false
		if err := lock(ctx, tx, c.UserID); err != nil {
			return err
		}
		current, err := s.cfg.Accounts.HoldKeys(ctx, tx, c)
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT seq, created_at, expires_at FROM clipboard_events WHERE user_id = $1::uuid AND event_id = $2`,
			c.UserID, eventID).Scan(&out.Seq, &out.CreatedAt, &out.ExpiresAt)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		st, last, err := s.settingsForUpdate(ctx, tx, c.UserID)
		if err != nil {
			return err
		}
		if st.Paused {
			return ErrPaused
		}
		if in.KeyVersion != current {
			return ErrKeyVersion
		}
		now := s.cfg.Clock.Now()
		out = Created{Seq: last + 1, CreatedAt: now, ExpiresAt: now.Add(time.Duration(st.RetentionDays) * 24 * time.Hour)}
		if _, err := tx.Exec(ctx,
			`INSERT INTO clipboard_events (user_id, event_id, seq, origin_device_id, event_type, mime_type, key_version, nonce,
			                               ciphertext, payload_size, created_at, expires_at)
			 VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12)`,
			c.UserID, eventID, out.Seq, c.DeviceID, in.EventType, in.MimeType, in.KeyVersion, nonce, ct, in.PayloadSize,
			out.CreatedAt, out.ExpiresAt); err != nil {
			return err
		}
		last = out.Seq
		// The cap: tombstone the oldest live events beyond MaxLive, each with a new seq after the new event's.
		rows, err := tx.Query(ctx,
			`SELECT event_id::text FROM clipboard_events
			  WHERE user_id = $1::uuid AND deleted_at IS NULL AND expires_at > $2
			  ORDER BY seq DESC OFFSET $3`, c.UserID, now, MaxLive)
		if err != nil {
			return err
		}
		over, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		for i := len(over) - 1; i >= 0; i-- { // oldest first
			last++
			if _, err := tx.Exec(ctx,
				`UPDATE clipboard_events SET seq = $3, deleted_at = $4, nonce = NULL, ciphertext = NULL
				  WHERE user_id = $1::uuid AND event_id = $2::uuid`, c.UserID, over[i], last, now); err != nil {
				return err
			}
			capped = append(capped, eventDeletedMsg{Type: "CLIPBOARD_EVENT_DELETED", EventID: over[i], Seq: last})
		}
		fresh = true
		return setLastSeq(ctx, tx, c.UserID, last)
	})
	if err != nil {
		return Created{}, err
	}
	out.CreatedAt, out.ExpiresAt = out.CreatedAt.UTC(), out.ExpiresAt.UTC()
	if fresh {
		msgs := []any{eventCreatedMsg{Type: "CLIPBOARD_EVENT_CREATED", EventID: eventID.String(), Seq: out.Seq, OriginDeviceID: c.DeviceID,
			CreatedAt: out.CreatedAt, PayloadSize: in.PayloadSize, KeyVersion: in.KeyVersion}}
		for _, m := range capped {
			msgs = append(msgs, m)
		}
		s.fanOut(ctx, c.UserID, "", msgs...)
	}
	return out, nil
}

const eventColumns = `event_id::text, seq, origin_device_id::text, event_type, mime_type, key_version, nonce, ciphertext,
	payload_size, created_at, expires_at, deleted_at IS NOT NULL`

func scanEvents(rows pgx.Rows) ([]Event, error) {
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var nonce, ct []byte
		if err := rows.Scan(&e.EventID, &e.Seq, &e.OriginDeviceID, &e.EventType, &e.MimeType, &e.KeyVersion, &nonce, &ct,
			&e.PayloadSize, &e.CreatedAt, &e.ExpiresAt, &e.Deleted); err != nil {
			return nil, err
		}
		if !e.Deleted {
			n, c := enc(nonce), enc(ct)
			e.Nonce, e.Ciphertext = &n, &c
		}
		e.CreatedAt, e.ExpiresAt = e.CreatedAt.UTC(), e.ExpiresAt.UTC()
		out = append(out, e)
	}
	return out, rows.Err()
}

// Events pages through events and tombstones with seq > cursor in seq order and records cursor as what the
// calling device has applied (never moving it backwards, and never past the account's highest seq). Because
// seq is assigned under the per-user lock and committed in order, a reader that resumes from next_cursor never
// skips or repeats. Live events past expires_at that the sweep has not removed yet are left out.
func (s *Service) Events(ctx context.Context, id access.Identity, cursor int64, limit int) (EventPage, error) {
	c, err := s.cfg.Accounts.RequireAdded(ctx, id)
	if err != nil {
		return EventPage{}, err
	}
	if err := allow(s.cfg.Limits.Read, c.DeviceID); err != nil {
		return EventPage{}, err
	}
	page := EventPage{NextCursor: cursor}
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		// The cursor write re-checks the session under the key-row lock, so it cannot land after the device's
		// departure deleted its cursor.
		if _, err := s.cfg.Accounts.HoldKeys(ctx, tx, c); err != nil {
			return err
		}
		now := s.cfg.Clock.Now()
		if _, err := tx.Exec(ctx,
			`INSERT INTO clipboard_device_cursors AS k (device_id, user_id, last_seq, updated_at)
			 VALUES ($1::uuid, $2::uuid,
			         LEAST($3::bigint, COALESCE((SELECT last_seq FROM clipboard_settings WHERE user_id = $2::uuid), 0)), $4)
			 ON CONFLICT (device_id) DO UPDATE SET
			   last_seq = CASE WHEN k.user_id = EXCLUDED.user_id THEN GREATEST(k.last_seq, EXCLUDED.last_seq) ELSE EXCLUDED.last_seq END,
			   user_id = EXCLUDED.user_id, updated_at = EXCLUDED.updated_at`,
			c.DeviceID, c.UserID, cursor, now); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+eventColumns+` FROM clipboard_events
			WHERE user_id = $1::uuid AND seq > $2 AND (deleted_at IS NOT NULL OR expires_at > $3)
			ORDER BY seq LIMIT $4`, c.UserID, cursor, now, limit)
		if err != nil {
			return err
		}
		page.Events, err = scanEvents(rows)
		return err
	})
	if err != nil {
		return EventPage{}, err
	}
	if n := len(page.Events); n > 0 {
		page.NextCursor = page.Events[n-1].Seq
	}
	return page, nil
}

// History returns the live events, newest first, and the account's current highest seq, read from one
// snapshot: the client shows them and then follows Events from cursor without missing anything.
func (s *Service) History(ctx context.Context, id access.Identity, limit int) (HistoryPage, error) {
	c, err := s.cfg.Accounts.RequireAdded(ctx, id)
	if err != nil {
		return HistoryPage{}, err
	}
	if err := allow(s.cfg.Limits.Read, c.DeviceID); err != nil {
		return HistoryPage{}, err
	}
	page := HistoryPage{}
	err = pgx.BeginTxFunc(ctx, s.cfg.Pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT last_seq FROM clipboard_settings WHERE user_id = $1::uuid`, c.UserID).Scan(&page.Cursor)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+eventColumns+` FROM clipboard_events
			WHERE user_id = $1::uuid AND deleted_at IS NULL AND expires_at > $2 ORDER BY seq DESC LIMIT $3`,
			c.UserID, s.cfg.Clock.Now(), limit)
		if err != nil {
			return err
		}
		page.Events, err = scanEvents(rows)
		return err
	})
	if err != nil {
		return HistoryPage{}, err
	}
	return page, nil
}

// Delete turns an event into a tombstone with a new seq so other devices learn of the deletion. Deleting a
// tombstone again changes nothing; an unknown event (or another account's) is 404.
func (s *Service) Delete(ctx context.Context, id access.Identity, eventID string) error {
	c, err := s.cfg.Accounts.RequireAdded(ctx, id)
	if err != nil {
		return err
	}
	if !auth.IsCanonicalUUID(eventID) {
		return ErrInvalid
	}
	if err := allow(s.cfg.Limits.Write, c.DeviceID); err != nil {
		return err
	}
	var msg *eventDeletedMsg
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		msg = nil
		if err := lock(ctx, tx, c.UserID); err != nil {
			return err
		}
		if _, err := s.cfg.Accounts.HoldKeys(ctx, tx, c); err != nil {
			return err
		}
		// FOR UPDATE: a row the sweep is deleting right now is waited for and then reads as gone (404).
		var deleted bool
		err := tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM clipboard_events WHERE user_id = $1::uuid AND event_id = $2::uuid FOR UPDATE`,
			c.UserID, eventID).Scan(&deleted)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil || deleted {
			return err
		}
		_, last, err := s.settingsForUpdate(ctx, tx, c.UserID)
		if err != nil {
			return err
		}
		last++
		if _, err := tx.Exec(ctx,
			`UPDATE clipboard_events SET seq = $3, deleted_at = $4, nonce = NULL, ciphertext = NULL
			  WHERE user_id = $1::uuid AND event_id = $2::uuid`, c.UserID, eventID, last, s.cfg.Clock.Now()); err != nil {
			return err
		}
		msg = &eventDeletedMsg{Type: "CLIPBOARD_EVENT_DELETED", EventID: eventID, Seq: last}
		return setLastSeq(ctx, tx, c.UserID, last)
	})
	if err != nil {
		return err
	}
	if msg != nil {
		s.fanOut(ctx, c.UserID, "", *msg)
	}
	return nil
}

// Clear tombstones every live event of the account, each with a new seq. Under the clipboard advisory lock it
// first locks the live rows in seq order (FOR UPDATE), so the rows it renumbers are exactly the rows it holds:
// a row the sweep deleted meanwhile is simply not returned, and the sweep (SKIP LOCKED) never waits on Clear.
func (s *Service) Clear(ctx context.Context, id access.Identity) error {
	c, err := s.cfg.Accounts.RequireAdded(ctx, id)
	if err != nil {
		return err
	}
	if err := allow(s.cfg.Limits.Write, c.DeviceID); err != nil {
		return err
	}
	var top int64
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		top = 0
		if err := lock(ctx, tx, c.UserID); err != nil {
			return err
		}
		if _, err := s.cfg.Accounts.HoldKeys(ctx, tx, c); err != nil {
			return err
		}
		_, last, err := s.settingsForUpdate(ctx, tx, c.UserID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx,
			`SELECT event_id::text FROM clipboard_events WHERE user_id = $1::uuid AND deleted_at IS NULL ORDER BY seq FOR UPDATE`, c.UserID)
		if err != nil {
			return err
		}
		live, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil || len(live) == 0 {
			return err
		}
		// New seqs start above every seq ever assigned, so the UNIQUE (user_id, seq) check never collides; the
		// rows are held, so exactly len(live) seqs are used.
		tag, err := tx.Exec(ctx,
			`UPDATE clipboard_events e SET seq = $2 + o.rn, deleted_at = $3, nonce = NULL, ciphertext = NULL
			   FROM unnest($4::uuid[]) WITH ORDINALITY AS o(event_id, rn)
			  WHERE e.user_id = $1::uuid AND e.event_id = o.event_id`, c.UserID, last, s.cfg.Clock.Now(), live)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != int64(len(live)) {
			return fmt.Errorf("clipboard clear: tombstoned %d of %d held rows", tag.RowsAffected(), len(live))
		}
		top = last + int64(len(live))
		return setLastSeq(ctx, tx, c.UserID, top)
	})
	if err != nil {
		return err
	}
	if top > 0 {
		s.fanOut(ctx, c.UserID, "", historyClearedMsg{Type: "CLIPBOARD_HISTORY_CLEARED", Seq: top})
	}
	return nil
}

// GetSettings returns the account's clipboard settings (the defaults until it stores its own).
func (s *Service) GetSettings(ctx context.Context, id access.Identity) (Settings, error) {
	c, err := s.cfg.Accounts.RequireAdded(ctx, id)
	if err != nil {
		return Settings{}, err
	}
	st := DefaultSettings
	err = s.cfg.Pool.QueryRow(ctx, `SELECT paused, retention_days, sensitive_skip FROM clipboard_settings WHERE user_id = $1::uuid`,
		c.UserID).Scan(&st.Paused, &st.RetentionDays, &st.SensitiveSkip)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultSettings, nil
	}
	return st, err
}

// PutSettings stores the account's clipboard settings. A new retention applies to events created afterwards.
func (s *Service) PutSettings(ctx context.Context, id access.Identity, in Settings) (Settings, error) {
	c, err := s.cfg.Accounts.RequireAdded(ctx, id)
	if err != nil {
		return Settings{}, err
	}
	if in.RetentionDays < 1 || in.RetentionDays > 7 {
		return Settings{}, ErrInvalid
	}
	if err := allow(s.cfg.Limits.Write, c.DeviceID); err != nil {
		return Settings{}, err
	}
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		if _, err := s.cfg.Accounts.HoldKeys(ctx, tx, c); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO clipboard_settings (user_id, paused, retention_days, sensitive_skip, updated_at)
			 VALUES ($1::uuid, $2, $3, $4, $5)
			 ON CONFLICT (user_id) DO UPDATE SET paused = EXCLUDED.paused, retention_days = EXCLUDED.retention_days,
			   sensitive_skip = EXCLUDED.sensitive_skip, updated_at = EXCLUDED.updated_at`,
			c.UserID, in.Paused, in.RetentionDays, in.SensitiveSkip, s.cfg.Clock.Now())
		return err
	})
	if err != nil {
		return Settings{}, err
	}
	s.fanOut(ctx, c.UserID, "", settingsUpdatedMsg{Type: "CLIPBOARD_SETTINGS_UPDATED", Settings: in})
	return in, nil
}

// SweepResult counts what one sweep removed.
type SweepResult struct {
	Expired    int64
	Tombstones int64
}

// Sweep batching: each statement deletes at most sweepBatch rows; one pass runs at most sweepMaxBatches
// statements per kind, and whatever is left (or was skipped) goes in the next pass.
const (
	sweepBatch      = 500
	sweepMaxBatches = 200
)

// Sweep hard-deletes live events past expires_at and tombstones older than TombstoneTTL. It runs from the
// account maintenance loop (auth.Service.OnSweep). seq values are never reused: they come from
// clipboard_settings.last_seq, not from the remaining rows.
//
// The sweep never waits on a row lock, so it cannot deadlock with Clear, Delete, or Create (which lock rows
// under the per-account advisory lock): each batch picks its rows in a fixed order (user_id, seq) with
// FOR UPDATE SKIP LOCKED and deletes them in its own short statement. A row a writer holds is skipped and
// picked up by a later pass if it still qualifies.
func (s *Service) Sweep(ctx context.Context) (SweepResult, error) {
	now := s.cfg.Clock.Now()
	var res SweepResult
	var err error
	res.Expired, err = s.sweepKind(ctx, `deleted_at IS NULL AND expires_at <= $1`, now)
	if err != nil {
		return res, err
	}
	res.Tombstones, err = s.sweepKind(ctx, `deleted_at IS NOT NULL AND deleted_at <= $1`, now.Add(-TombstoneTTL))
	return res, err
}

// sweepKind deletes the rows matching where (with $1 = before) in bounded SKIP LOCKED batches.
func (s *Service) sweepKind(ctx context.Context, where string, before time.Time) (int64, error) {
	var total int64
	for i := 0; i < sweepMaxBatches; i++ {
		tag, err := s.cfg.Pool.Exec(ctx,
			`DELETE FROM clipboard_events e
			  USING (SELECT user_id, event_id FROM clipboard_events WHERE `+where+`
			          ORDER BY user_id, seq LIMIT $2 FOR UPDATE SKIP LOCKED) d
			  WHERE e.user_id = d.user_id AND e.event_id = d.event_id`, before, sweepBatch)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < sweepBatch {
			break
		}
	}
	return total, nil
}

// RunSweep is Sweep in the form auth.Service.OnSweep takes.
func (s *Service) RunSweep(ctx context.Context) error {
	res, err := s.Sweep(ctx)
	if err == nil && res.Expired+res.Tombstones > 0 {
		s.cfg.Log.Info("clipboard sweep", "expired", res.Expired, "tombstones", res.Tombstones)
	}
	return err
}

// recipients returns the account's devices with a live added account session now, except skip.
func (s *Service) recipients(ctx context.Context, userID, skip string) ([]string, error) {
	rows, err := s.cfg.Pool.Query(ctx,
		`SELECT a.device_id::text FROM auth_sessions a JOIN devices d ON d.id = a.device_id
		  WHERE a.user_id = $1::uuid AND a.device_added AND a.revoked_at IS NULL AND a.expires_at > $2
		    AND d.revoked_at IS NULL AND ($3::uuid IS NULL OR a.device_id <> $3::uuid)`,
		userID, s.cfg.Clock.Now(), nullable(skip))
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// fanOut sends msgs to every open socket of the account's devices that have a live added account session at
// send time (the origin device included unless skipped). Failures are logged; clients also catch up by cursor
// on reconnect.
func (s *Service) fanOut(ctx context.Context, userID, skip string, msgs ...any) {
	if s.cfg.Notify == nil || len(msgs) == 0 {
		return
	}
	// The request's cancellation does not stop the notification, but the lookup is bounded.
	nctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), notifyTimeout)
	defer cancel()
	ids, err := s.recipients(nctx, userID, skip)
	if err != nil {
		s.cfg.Log.Error("clipboard notification failed", "error", err.Error())
		return
	}
	for _, id := range ids {
		for _, m := range msgs {
			s.cfg.Notify.SendToDevice(id, m)
		}
	}
}

// Presence is registered with ws.Hub.OnPresence: when an added device of an account opens its first socket or
// closes its last one, the account's other added devices get DEVICE_CONNECTED or DEVICE_DISCONNECTED.
// Devices without a live added session (guests, not-added, departed) announce nothing. The hub runs it on a
// presence worker after WELCOME (never on the handshake); each call is bounded by notifyTimeout.
func (s *Service) Presence(deviceID string, connected bool) {
	ctx, cancel := context.WithTimeout(context.Background(), notifyTimeout)
	defer cancel()
	var userID string
	err := s.cfg.Pool.QueryRow(ctx,
		`SELECT user_id::text FROM auth_sessions
		  WHERE device_id = $1::uuid AND device_added AND revoked_at IS NULL AND expires_at > $2`, deviceID, s.cfg.Clock.Now()).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		s.cfg.Log.Error("device presence notification failed", "error", err.Error())
		return
	}
	t := "DEVICE_DISCONNECTED"
	if connected {
		t = "DEVICE_CONNECTED"
	}
	s.fanOut(ctx, userID, deviceID, deviceMsg{Type: t, DeviceID: deviceID})
}
