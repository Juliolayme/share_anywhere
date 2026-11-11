package auth

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
)

// Credentials are the sign-up and sign-in inputs.
type Credentials struct {
	Email       string
	Password    string
	AddDevice   bool
	CopyHistory bool
}

// AuthResult is returned by sign-up and sign-in.
type AuthResult struct {
	Session devices.Session
	UserID  string
	Email   string
	// Binding is the sa_acct cookie value for a not-added Web session ("" otherwise).
	Binding string
}

// NormalizeEmail trims and lowercases an address and checks it is a plain addr-spec with a dotted domain.
func NormalizeEmail(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) < 3 || len(s) > 254 {
		return "", ErrInvalidEmail
	}
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || a.Name != "" {
		return "", ErrInvalidEmail
	}
	local, domain, ok := strings.Cut(s, "@")
	if !ok || local == "" || len(local) > 64 || !strings.Contains(domain, ".") ||
		strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") || strings.ContainsAny(s, " \t\r\n\"()<>[]\\,;:") {
		return "", ErrInvalidEmail
	}
	return s, nil
}

func (s *Service) result(ctx context.Context, deviceID, userID, email, binding string) (AuthResult, error) {
	sess, err := s.cfg.Devices.Token(ctx, deviceID)
	if err != nil {
		return AuthResult{}, err
	}
	return AuthResult{Session: sess, UserID: userID, Email: email, Binding: binding}, nil
}

// SignUp creates an account and binds an account session to the calling device (the device ID does not
// change, so running transfers continue).
func (s *Service) SignUp(ctx context.Context, id access.Identity, ipKey string, in Credentials) (AuthResult, error) {
	email, err := NormalizeEmail(in.Email)
	if err != nil {
		return AuthResult{}, err
	}
	if CheckPassword(in.Password, email) != nil {
		return AuthResult{}, ErrWeak
	}
	if id.AccountID != "" {
		return AuthResult{}, ErrAlreadySignedIn
	}
	if err := allow(s.cfg.Limits.SignupIP, ipKey, s.cfg.Limits.SignupDevice, id.DeviceID); err != nil {
		return AuthResult{}, err
	}
	if on, err := s.signedIn(ctx, id.DeviceID); err != nil || on {
		return AuthResult{}, firstErr(err, ErrAlreadySignedIn)
	}
	hash, err := s.cfg.Hasher.Hash(ctx, in.Password)
	if err != nil {
		return AuthResult{}, err
	}
	binding, bindingHash, err := s.browserBinding(ctx, id.DeviceID, in.AddDevice)
	if err != nil {
		return AuthResult{}, err
	}
	now := s.cfg.Clock.Now()
	userID := newID()
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO users (id, email, password_hash, created_at, password_changed_at) VALUES ($1::uuid, $2, $3, $4, $4)`,
			userID, email, hash, now); err != nil {
			if isUniqueViolation(err, "users_email_key") {
				return ErrEmailTaken
			}
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO account_keys (user_id, updated_at) VALUES ($1::uuid, $2)`, userID, now); err != nil {
			return err
		}
		return s.startSession(ctx, tx, now, userID, id.DeviceID, in.AddDevice, bindingHash)
	})
	if err != nil {
		return AuthResult{}, err
	}
	return s.result(ctx, id.DeviceID, userID, email, binding)
}

func firstErr(err error, fallback error) error {
	if err != nil {
		return err
	}
	return fallback
}

// SignIn verifies email and password and binds an account session to the calling device. An unknown email
// costs one Argon2id verification too and gets the same response as a wrong password.
func (s *Service) SignIn(ctx context.Context, id access.Identity, ipKey string, in Credentials) (AuthResult, error) {
	email, emailErr := NormalizeEmail(in.Email)
	if emailErr != nil {
		email = strings.ToLower(strings.TrimSpace(in.Email))
	}
	if id.AccountID != "" {
		return AuthResult{}, ErrAlreadySignedIn
	}
	l := s.cfg.Limits
	if err := allow(l.SigninIP, ipKey, l.SigninIPEmail, ipKey+"|"+email, l.SigninDevice, id.DeviceID); err != nil {
		return AuthResult{}, err
	}
	if ok, wait := l.SigninEmail.Check(email); !ok {
		return AuthResult{}, rateLimited(wait)
	}
	if emailErr != nil || len(in.Password) > 4*MaxPasswordLen {
		_, _, _ = s.cfg.Hasher.Verify(ctx, "", in.Password[:min(len(in.Password), 4*MaxPasswordLen)])
		l.SigninEmail.Allow(email)
		return AuthResult{}, ErrInvalidCreds
	}
	if on, err := s.signedIn(ctx, id.DeviceID); err != nil || on {
		return AuthResult{}, firstErr(err, ErrAlreadySignedIn)
	}
	var userID, stored string
	err := s.cfg.Pool.QueryRow(ctx, `SELECT id::text, password_hash FROM users WHERE email = $1`, email).Scan(&userID, &stored)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return AuthResult{}, err
	}
	ok, rehash, err := s.cfg.Hasher.Verify(ctx, stored, in.Password)
	if err != nil {
		return AuthResult{}, err
	}
	if !ok {
		l.SigninEmail.Allow(email)
		return AuthResult{}, ErrInvalidCreds
	}
	var newHash string
	if rehash {
		if newHash, err = s.cfg.Hasher.Hash(ctx, in.Password); err != nil {
			return AuthResult{}, err
		}
	}
	binding, bindingHash, err := s.browserBinding(ctx, id.DeviceID, in.AddDevice)
	if err != nil {
		return AuthResult{}, err
	}
	now := s.cfg.Clock.Now()
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		if newHash != "" {
			if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1::uuid`, userID, newHash); err != nil {
				return err
			}
		}
		return s.startSession(ctx, tx, now, userID, id.DeviceID, in.AddDevice, bindingHash)
	})
	if err != nil {
		return AuthResult{}, err
	}
	return s.result(ctx, id.DeviceID, userID, email, binding)
}

// SignOut ends the device's account session, removes it from the account, revokes the device identity, and
// returns a brand-new anonymous identity so later guest activity cannot be linked to the account (PRD §2).
func (s *Service) SignOut(ctx context.Context, id access.Identity) (devices.Session, error) {
	se, err := s.require(ctx, id, false)
	if err != nil {
		return devices.Session{}, err
	}
	var ids []string
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		ids, err = s.detach(ctx, tx, s.cfg.Clock.Now(), detachFilter{Device: se.DeviceID})
		return err
	})
	if err != nil {
		return devices.Session{}, err
	}
	s.forget(ids)
	return s.cfg.Devices.Replace(ctx, se.DeviceID)
}

// RequestReset answers the same way whether or not the email has an account: after the rate limits, the
// lookup, token creation, and mail happen in the background so neither the response nor its timing reveals
// whether the account exists.
func (s *Service) RequestReset(ctx context.Context, ipKey, email string) error {
	norm, emailErr := NormalizeEmail(email)
	if emailErr != nil {
		norm = strings.ToLower(strings.TrimSpace(email))
	}
	if err := allow(s.cfg.Limits.ResetIP, ipKey, s.cfg.Limits.ResetEmail, norm); err != nil {
		return err
	}
	if emailErr != nil {
		return nil // no account can have this address; same 202
	}
	s.background(func() { s.sendReset(norm) })
	return nil
}

func (s *Service) sendReset(email string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var userID string
	err := s.cfg.Pool.QueryRow(ctx, `SELECT id::text FROM users WHERE email = $1`, email).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		s.cfg.Log.Error("password reset lookup failed", "error", err.Error())
		return
	}
	tok, hash := newToken(32)
	now := s.cfg.Clock.Now()
	if _, err := s.cfg.Pool.Exec(ctx,
		`INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES ($1, $2::uuid, $3, $4)`,
		hash, userID, now, now.Add(ResetTokenTTL)); err != nil {
		s.cfg.Log.Error("password reset insert failed", "error", err.Error())
		return
	}
	link := s.cfg.PublicURL + "/reset?token=" + tok
	msg := Message{
		To:      email,
		Subject: "Reset your Share Anywhere password",
		Body: "Someone asked to reset the password of your Share Anywhere account.\n\n" +
			"Open this link within 30 minutes to choose a new password:\n" + link + "\n\n" +
			"If it wasn't you, ignore this email; your password stays the same.\n",
		Link: link,
	}
	if err := s.cfg.Mailer.Send(ctx, msg); err != nil {
		// Mailer errors (SMTP replies, address errors) may quote the recipient: log the class only.
		s.cfg.Log.Error("password reset mail failed", "error_class", errClass(err))
	}
}

// errClass names an error without its text, which may carry personal data (docs/SECURITY_MODEL.md §7).
func errClass(err error) string {
	var ne net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "timeout"
	case errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	default:
		return fmt.Sprintf("%T", err)
	}
}

// ConfirmReset sets a new password with a single-use reset token and ends every account session of the
// account (all its devices must sign in again).
func (s *Service) ConfirmReset(ctx context.Context, token, password string) error {
	if token == "" || len(token) > 128 {
		return ErrResetInvalid
	}
	hash := hashToken(token)
	now := s.cfg.Clock.Now()
	var userID, email string
	err := s.cfg.Pool.QueryRow(ctx,
		`SELECT r.user_id::text, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
		  WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > $2`, hash, now).Scan(&userID, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrResetInvalid
	}
	if err != nil {
		return err
	}
	if CheckPassword(password, email) != nil {
		return ErrWeak
	}
	ph, err := s.cfg.Hasher.Hash(ctx, password)
	if err != nil {
		return err
	}
	var ids []string
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`, hash, now)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrResetInvalid
		}
		if _, err := tx.Exec(ctx, `UPDATE password_resets SET used_at = $2 WHERE user_id = $1::uuid AND used_at IS NULL`, userID, now); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1::uuid`, userID, ph, now); err != nil {
			return err
		}
		ids, err = s.detach(ctx, tx, now, detachFilter{User: userID})
		return err
	})
	if err != nil {
		return err
	}
	s.forget(ids)
	return nil
}

// Me is the signed-in account as seen from the calling device.
type Me struct {
	ID          string    `json:"id"`
	Email       string    `json:"email"`
	CreatedAt   time.Time `json:"created_at"`
	Device      MeDevice  `json:"device"`
	HistorySync bool      `json:"history_sync"`
}

// MeDevice is the calling device's place in the account.
type MeDevice struct {
	ID    string `json:"id"`
	Added bool   `json:"added"`
}

// GetMe returns the account of the calling device.
func (s *Service) GetMe(ctx context.Context, id access.Identity) (Me, error) {
	se, err := s.require(ctx, id, false)
	if err != nil {
		return Me{}, err
	}
	return s.me(ctx, s.cfg.Pool, se)
}

func (s *Service) me(ctx context.Context, q querier, se session) (Me, error) {
	m := Me{ID: se.UserID, Device: MeDevice{ID: se.DeviceID, Added: se.Added}}
	err := q.QueryRow(ctx, `SELECT email, created_at, history_sync FROM users WHERE id = $1::uuid`, se.UserID).
		Scan(&m.Email, &m.CreatedAt, &m.HistorySync)
	m.CreatedAt = m.CreatedAt.UTC()
	return m, err
}

// UpdateMe changes account settings visible to every device (history_sync). Only an added device may change
// the account (a not-added session is read-only).
func (s *Service) UpdateMe(ctx context.Context, id access.Identity, historySync *bool) (Me, error) {
	se, err := s.require(ctx, id, true)
	if err != nil {
		return Me{}, err
	}
	if historySync != nil {
		if _, err := s.cfg.Pool.Exec(ctx, `UPDATE users SET history_sync = $2 WHERE id = $1::uuid`, se.UserID, *historySync); err != nil {
			return Me{}, err
		}
	}
	return s.me(ctx, s.cfg.Pool, se)
}

// ChangePassword checks the current password, sets a new one, and ends the account sessions of every other
// device.
func (s *Service) ChangePassword(ctx context.Context, id access.Identity, current, next string) error {
	se, err := s.require(ctx, id, false)
	if err != nil {
		return err
	}
	if ok, wait := s.cfg.Limits.PasswordChange.Check(se.UserID); !ok {
		return rateLimited(wait)
	}
	var email, stored string
	if err := s.cfg.Pool.QueryRow(ctx, `SELECT email, password_hash FROM users WHERE id = $1::uuid`, se.UserID).Scan(&email, &stored); err != nil {
		return err
	}
	if len(current) > 4*MaxPasswordLen {
		current = ""
	}
	ok, _, err := s.cfg.Hasher.Verify(ctx, stored, current)
	if err != nil {
		return err
	}
	if !ok {
		s.cfg.Limits.PasswordChange.Allow(se.UserID)
		return ErrWrongPassword
	}
	if CheckPassword(next, email) != nil {
		return ErrWeak
	}
	ph, err := s.cfg.Hasher.Hash(ctx, next)
	if err != nil {
		return err
	}
	now := s.cfg.Clock.Now()
	var ids []string
	err = pgx.BeginFunc(ctx, s.cfg.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1::uuid`, se.UserID, ph, now); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE password_resets SET used_at = $2 WHERE user_id = $1::uuid AND used_at IS NULL`, se.UserID, now); err != nil {
			return err
		}
		ids, err = s.detach(ctx, tx, now, detachFilter{User: se.UserID, ExceptDev: se.DeviceID})
		return err
	})
	if err != nil {
		return err
	}
	s.forget(ids)
	return nil
}
