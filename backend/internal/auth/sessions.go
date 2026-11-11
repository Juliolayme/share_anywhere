package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
)

// querier is satisfied by the pool and by a transaction.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// AccountState implements devices.Accounts: the device's active, unexpired, unrevoked account session.
func (s *Service) AccountState(ctx context.Context, deviceID string) (devices.AccountState, error) {
	var st devices.AccountState
	err := s.cfg.Pool.QueryRow(ctx,
		`SELECT user_id::text, device_added FROM auth_sessions
		  WHERE device_id = $1::uuid AND revoked_at IS NULL AND expires_at > $2`, deviceID, s.cfg.Clock.Now()).Scan(&st.AccountID, &st.Added)
	if errors.Is(err, pgx.ErrNoRows) {
		return devices.AccountState{}, nil
	}
	return st, err
}

// Refreshed implements devices.Accounts for a token refresh. A not-added session started from a Web
// (cookie-transport) device is bound to the browser session: the presented sa_acct cookie must hash to the
// stored binding, or the account session ends the way an expired one does (the device leaves the account)
// and the refresh yields a guest token (docs/ADR/0013-session-hardening.md). Otherwise the refresh records
// use and slides an added device's session to 90 days from now.
func (s *Service) Refreshed(ctx context.Context, deviceID, browserBinding string) (devices.AccountState, error) {
	now := s.cfg.Clock.Now()
	var st devices.AccountState
	var ended []string
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		var id string
		var bound []byte
		err := tx.QueryRow(ctx,
			`SELECT id::text, user_id::text, device_added, browser_binding FROM auth_sessions
			  WHERE device_id = $1::uuid AND revoked_at IS NULL AND expires_at > $2 FOR UPDATE`, deviceID, now,
		).Scan(&id, &st.AccountID, &st.Added, &bound)
		if errors.Is(err, pgx.ErrNoRows) {
			st = devices.AccountState{}
			return nil
		}
		if err != nil {
			return err
		}
		if !st.Added && bound != nil && subtle.ConstantTimeCompare(hashToken(browserBinding), bound) != 1 {
			st = devices.AccountState{}
			ended, err = s.detach(ctx, tx, now, detachFilter{Device: deviceID})
			return err
		}
		_, err = tx.Exec(ctx,
			`UPDATE auth_sessions SET last_used_at = $2, expires_at = CASE WHEN device_added THEN $3 ELSE expires_at END
			  WHERE id = $1::uuid`, id, now, now.Add(AddedSessionIdle))
		return err
	})
	if err != nil {
		return devices.AccountState{}, err
	}
	s.forget(ended)
	return st, nil
}

// browserBinding returns a fresh sa_acct cookie value and its SHA-256 for a not-added session of a Web
// (cookie-transport) device. Added sessions and native (body-transport) devices get none.
func (s *Service) browserBinding(ctx context.Context, deviceID string, added bool) (string, []byte, error) {
	if added {
		return "", nil, nil
	}
	d, err := s.cfg.Devices.Get(ctx, deviceID)
	if err != nil {
		return "", nil, err
	}
	if d.Transport != devices.TransportCookie {
		return "", nil, nil
	}
	tok, hash := newToken(32)
	return tok, hash, nil
}

// session is the caller's verified account session.
type session struct {
	ID       string
	UserID   string
	DeviceID string
	Added    bool
}

// require loads the caller's live account session and checks it against the token, so a revoked or
// signed-out device loses access at once even if its access token has not expired.
func (s *Service) require(ctx context.Context, id access.Identity, needAdded bool) (session, error) {
	if id.AccountID == "" {
		return session{}, ErrAccountRequired
	}
	var se session
	err := s.cfg.Pool.QueryRow(ctx,
		`SELECT id::text, user_id::text, device_id::text, device_added FROM auth_sessions
		  WHERE device_id = $1::uuid AND revoked_at IS NULL AND expires_at > $2`, id.DeviceID, s.cfg.Clock.Now(),
	).Scan(&se.ID, &se.UserID, &se.DeviceID, &se.Added)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && se.UserID != id.AccountID) {
		return session{}, ErrTokenStale
	}
	if err != nil {
		return session{}, err
	}
	if needAdded && (!se.Added || !id.DeviceAdded) {
		return session{}, ErrDeviceNotAdded
	}
	return se, nil
}

// detachFilter selects account sessions to end.
type detachFilter struct {
	Device      string // only this device
	User        string // only this account
	ExceptDev   string // not this device
	ExpiredOnly bool   // only sessions past expires_at
}

// detach ends the selected account sessions and removes their devices from the account: the device becomes
// anonymous again (30-day lifetime), and its wrapping key, pending key blobs, and pairing are deleted. When a
// leaving device had a registered wrapping key, its account's rotation_due is set.
// It returns the affected device IDs; call forget after the transaction commits.
func (s *Service) detach(ctx context.Context, tx pgx.Tx, now time.Time, f detachFilter) ([]string, error) {
	rows, err := tx.Query(ctx,
		`UPDATE auth_sessions SET revoked_at = $1
		  WHERE revoked_at IS NULL
		    AND ($2::uuid IS NULL OR device_id = $2::uuid)
		    AND ($3::uuid IS NULL OR user_id = $3::uuid)
		    AND ($4::uuid IS NULL OR device_id <> $4::uuid)
		    AND (NOT $5::boolean OR expires_at <= $1)
		  RETURNING device_id::text`, now, nullable(f.Device), nullable(f.User), nullable(f.ExceptDev), f.ExpiredOnly)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(ids) == 0 {
		return ids, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE devices SET kind = 'anonymous', user_id = NULL, expires_at = LEAST(expires_at, $2::timestamptz)
		  WHERE id = ANY($1::uuid[]) AND kind = 'account'`, ids, now.Add(devices.AnonymousLifetime)); err != nil {
		return nil, err
	}
	// A device with a registered (proven) wrapping key held the ADK: its account now owes a rotation
	// (docs/ADR/0014-current-version-proofs.md). Every way of leaving an account runs through here, so the
	// flag is set in the same transaction as the departure, before the key row that shows it is deleted.
	for _, q := range []string{
		`UPDATE account_keys SET rotation_due = true
		  WHERE user_id IN (SELECT user_id FROM device_keys WHERE device_id = ANY($1::uuid[])) AND NOT rotation_due`,
		`DELETE FROM device_keys WHERE device_id = ANY($1::uuid[])`,
		`DELETE FROM device_key_blobs WHERE device_id = ANY($1::uuid[])`,
		`DELETE FROM device_pairings WHERE new_device_id = ANY($1::uuid[])`,
	} {
		if _, err := tx.Exec(ctx, q, ids); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

func (s *Service) forget(ids []string) {
	for _, id := range ids {
		s.cfg.Devices.Forget(id)
	}
}

// DeviceRevoked ends the account session of a device whose identity was revoked (reset, refresh-secret
// reuse); registered with devices.Service.OnRevoke.
func (s *Service) DeviceRevoked(deviceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var ids []string
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		var err error
		ids, err = s.detach(ctx, tx, s.cfg.Clock.Now(), detachFilter{Device: deviceID})
		return err
	})
	if err != nil {
		s.cfg.Log.Error("ending the account session of a revoked device failed", "error", err.Error())
		return
	}
	s.forget(ids)
}

// startSession binds a new account session to the device inside tx. Expired sessions of the device are
// ended first; a live one means the device is already signed in. binding is the SHA-256 of the sa_acct
// cookie for a not-added Web session (nil otherwise).
func (s *Service) startSession(ctx context.Context, tx pgx.Tx, now time.Time, userID, deviceID string, added bool, binding []byte) error {
	if _, err := s.detach(ctx, tx, now, detachFilter{Device: deviceID, ExpiredOnly: true}); err != nil {
		return err
	}
	expires := now.Add(NotAddedSessionMax)
	if added {
		expires = now.Add(AddedSessionIdle)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO auth_sessions (id, user_id, device_id, device_added, created_at, last_used_at, expires_at, browser_binding)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $5, $6, $7)`, newID(), userID, deviceID, added, now, expires, binding); err != nil {
		if isUniqueViolation(err, "auth_sessions_device_active_key") {
			return ErrAlreadySignedIn
		}
		return err
	}
	if added {
		return markAdded(ctx, tx, now, userID, deviceID)
	}
	return nil
}

func markAdded(ctx context.Context, tx pgx.Tx, now time.Time, userID, deviceID string) error {
	tag, err := tx.Exec(ctx,
		`UPDATE devices SET kind = 'account', user_id = $2::uuid, expires_at = GREATEST(expires_at, $3)
		  WHERE id = $1::uuid AND revoked_at IS NULL`, deviceID, userID, now.Add(devices.AccountLifetime))
	if err == nil && tag.RowsAffected() == 0 {
		return ErrTokenStale
	}
	return err
}

// signedIn reports whether the device has a live account session.
func (s *Service) signedIn(ctx context.Context, deviceID string) (bool, error) {
	var one int
	err := s.cfg.Pool.QueryRow(ctx,
		`SELECT 1 FROM auth_sessions WHERE device_id = $1::uuid AND revoked_at IS NULL AND expires_at > $2`,
		deviceID, s.cfg.Clock.Now()).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// AccountDevice is one row of the account-wide Devices list.
type AccountDevice struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Platform   string    `json:"platform"`
	Added      bool      `json:"added"`
	Current    bool      `json:"current"`
	LastSeenAt time.Time `json:"last_seen_at"`
	CreatedAt  time.Time `json:"created_at"`
	HasKey     bool      `json:"has_key"`
}

const accountDeviceSelect = `SELECT d.id::text, d.display_name, d.platform, a.device_added, d.last_seen_at, d.created_at,
	       EXISTS (SELECT 1 FROM device_keys k WHERE k.device_id = d.id AND k.user_id = a.user_id)
	  FROM auth_sessions a JOIN devices d ON d.id = a.device_id
	 WHERE a.user_id = $1::uuid AND a.revoked_at IS NULL AND a.expires_at > $2 AND d.revoked_at IS NULL AND d.expires_at > $2`

func scanAccountDevice(row pgx.Row, current string) (AccountDevice, error) {
	var d AccountDevice
	err := row.Scan(&d.ID, &d.Name, &d.Platform, &d.Added, &d.LastSeenAt, &d.CreatedAt, &d.HasKey)
	d.Current = d.ID == current
	d.LastSeenAt, d.CreatedAt = d.LastSeenAt.UTC(), d.CreatedAt.UTC()
	return d, err
}

// ListDevices returns the devices with a live account session for the caller's account, current first.
func (s *Service) ListDevices(ctx context.Context, id access.Identity) ([]AccountDevice, error) {
	se, err := s.require(ctx, id, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.cfg.Pool.Query(ctx, accountDeviceSelect+` ORDER BY (d.id = $3::uuid) DESC, d.last_seen_at DESC`,
		se.UserID, s.cfg.Clock.Now(), se.DeviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AccountDevice{}
	for rows.Next() {
		d, err := scanAccountDevice(rows, se.DeviceID)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// RenameDevice renames one of the account's devices. Only an added device may change the account (a
// not-added session is read-only, docs/API.md §2.4).
func (s *Service) RenameDevice(ctx context.Context, id access.Identity, deviceID, name string) (AccountDevice, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return AccountDevice{}, err
	}
	clean, err := devices.ValidateName(name)
	if err != nil {
		return AccountDevice{}, ErrInvalid
	}
	now := s.cfg.Clock.Now()
	tag, err := s.cfg.Pool.Exec(ctx,
		`UPDATE devices d SET display_name = $3 FROM auth_sessions a
		  WHERE d.id = $1::uuid AND a.device_id = d.id AND a.user_id = $2::uuid AND a.revoked_at IS NULL
		    AND a.expires_at > $4 AND d.revoked_at IS NULL AND d.expires_at > $4`, deviceID, se.UserID, clean, now)
	if err != nil {
		return AccountDevice{}, err
	}
	if tag.RowsAffected() == 0 {
		return AccountDevice{}, ErrNotFound
	}
	d, err := scanAccountDevice(s.cfg.Pool.QueryRow(ctx, accountDeviceSelect+` AND d.id = $3::uuid`, se.UserID, now, deviceID), se.DeviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountDevice{}, ErrNotFound
	}
	return d, err
}

// RevokeDevice ends another device's account session and removes it from the account; that device keeps
// its guest identity. The caller must be an added device and then rotates the ADK (PRD §7.5).
func (s *Service) RevokeDevice(ctx context.Context, id access.Identity, deviceID string) error {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return err
	}
	if deviceID == se.DeviceID {
		return ErrUseSignout
	}
	var ids []string
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		ids, err = s.detach(ctx, tx, s.cfg.Clock.Now(), detachFilter{Device: deviceID, User: se.UserID})
		if err == nil && len(ids) == 0 {
			return ErrNotFound
		}
		return err
	})
	if err != nil {
		return err
	}
	s.forget(ids)
	return nil
}

// AddCurrent adds the calling device to its account: the session becomes an added one (90-day sliding), its
// browser-session binding is dropped (the sa_acct cookie is cleared by the handler), and the device becomes
// an account device. Idempotent.
func (s *Service) AddCurrent(ctx context.Context, id access.Identity) (devices.Session, error) {
	se, err := s.require(ctx, id, false)
	if err != nil {
		return devices.Session{}, err
	}
	now := s.cfg.Clock.Now()
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE auth_sessions SET device_added = true, browser_binding = NULL, last_used_at = $2, expires_at = $3 WHERE id = $1::uuid`,
			se.ID, now, now.Add(AddedSessionIdle)); err != nil {
			return err
		}
		return markAdded(ctx, tx, now, se.UserID, se.DeviceID)
	})
	if err != nil {
		return devices.Session{}, err
	}
	return s.cfg.Devices.Token(ctx, se.DeviceID)
}

// Sweep ends expired account sessions (removing those devices from their accounts) and deletes expired
// pairings and reset tokens. It runs periodically from cmd/server.
func (s *Service) Sweep(ctx context.Context) error {
	now := s.cfg.Clock.Now()
	var ids []string
	err := pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		var err error
		if ids, err = s.detach(ctx, tx, now, detachFilter{ExpiredOnly: true}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM device_pairings WHERE expires_at < $1`, now.Add(-time.Hour)); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM password_resets WHERE expires_at < $1`, now.Add(-24*time.Hour))
		return err
	})
	if err == nil {
		s.forget(ids)
	}
	return err
}

// Run sweeps every interval until ctx ends.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Sweep(ctx); err != nil && ctx.Err() == nil {
				s.cfg.Log.Error("account sweep failed", "error", err.Error())
			}
		}
	}
}
