package transfers

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/metrics"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/objectstore"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// Cloud Distribution (docs/ARCHITECTURE.md §6, docs/ADR/0030-cloud-distribution.md): a signed-in sender who enabled
// it and consented uploads each file as client-side encrypted parts; joined receivers (guests too) download the parts
// through the server, which meters every byte against the sender's monthly budget. Objects expire after the TTL and
// are deleted once every joined receiver has them, or when the session ends.

// MaxCloudObjectBytes bounds an estimate (a session holds at most 20 GB, docs/API.md §3 over_limit).
const MaxCloudObjectBytes = int64(20_000_000_000)

// PartOverhead is the per-part AES-GCM framing: a 12-byte nonce and a 16-byte tag (docs/TRANSFER_PROTOCOL.md §9).
const PartOverhead = 28

// Cloud defaults.
const (
	DefaultCloudPartSize  = 4 << 20
	DefaultCloudTTL       = 24 * time.Hour
	DefaultCloudBudget    = int64(10) << 30
	DefaultCloudMaxBudget = int64(1) << 40
)

// CloudConfig turns Cloud Distribution on (Config.Cloud nil keeps it off, the default).
type CloudConfig struct {
	Store         objectstore.Store
	TTL           time.Duration
	PartSize      int
	DefaultBudget int64
	MaxBudget     int64
	// Pricing for estimates; nil prices give "cost unknown" (docs/PRODUCT_REQUIREMENTS.md §6.6).
	PriceStorageGBMonth *float64
	PriceEgressGB       *float64
	Currency            string
	// PartLimit bounds part uploads and downloads per device.
	PartLimit *ratelimit.Limiter
	Log       *slog.Logger
}

type cloudCounters struct {
	consents, objects, uploaded, downloaded, exhausted, deleted, estimates *metrics.Counter
}

func newCloudCounters(r *metrics.Registry) cloudCounters {
	return cloudCounters{
		consents:   r.Counter("sa_cloud_consents_total", "Accounts that consented to Cloud Distribution."),
		objects:    r.Counter("sa_cloud_objects_total", "Files distributed through the cloud."),
		uploaded:   r.Counter("sa_cloud_bytes_uploaded_total", "Ciphertext bytes uploaded to Cloud Distribution."),
		downloaded: r.Counter("sa_cloud_bytes_downloaded_total", "Ciphertext bytes downloaded from Cloud Distribution."),
		exhausted:  r.Counter("sa_cloud_budget_exhausted_total", "Cloud part operations refused because the sender's budget is used up."),
		deleted:    r.Counter("sa_cloud_objects_deleted_total", "Cloud objects deleted (delivered, expired or session ended)."),
		estimates:  r.Counter("sa_cloud_estimates_total", "Cloud cost estimates shown before consent."),
	}
}

// Cloud object statuses.
const (
	CloudUploading = "UPLOADING"
	CloudReady     = "READY"
	CloudDeleted   = "DELETED"
)

// CloudObject is the API view of a distributed file.
type CloudObject struct {
	ID             string    `json:"id"`
	SessionID      string    `json:"session_id"`
	FileID         string    `json:"file_id"`
	Status         string    `json:"status"`
	Paused         bool      `json:"paused"`
	Size           int64     `json:"size"`
	PartSize       int       `json:"part_size"`
	PartCount      int       `json:"part_count"`
	PartsUploaded  int       `json:"parts_uploaded"`
	CiphertextSize int64     `json:"ciphertext_size"`
	CreatedAt      time.Time `json:"created_at"`
	ExpiresAt      time.Time `json:"expires_at"`
}

// CloudEvent is the WebSocket event sent to the sender and joined receivers when an object changes.
type CloudEvent struct {
	Type      string      `json:"type"` // CLOUD_UPDATED
	SessionID string      `json:"session_id"`
	Object    CloudObject `json:"object"`
}

// Pricing is the configured price list (amounts per GB in Currency).
type Pricing struct {
	Currency       string   `json:"currency"`
	StorageGBMonth *float64 `json:"storage_gb_month"`
	EgressGB       *float64 `json:"egress_gb"`
}

// CloudSettings is GET /v1/cloud/settings.
type CloudSettings struct {
	Available   bool     `json:"available"`
	SignedIn    bool     `json:"signed_in"`
	DeviceAdded bool     `json:"device_added"`
	Enabled     bool     `json:"enabled"`
	Consented   bool     `json:"consented"`
	BudgetBytes int64    `json:"budget_bytes"`
	UsedBytes   int64    `json:"used_bytes"`
	MaxBudget   int64    `json:"max_budget_bytes"`
	TTLHours    int      `json:"ttl_hours"`
	Pricing     *Pricing `json:"pricing"`
}

// CloudSettingsInput is PUT /v1/cloud/settings.
type CloudSettingsInput struct {
	Enabled     bool   `json:"enabled"`
	Consent     bool   `json:"consent"`
	BudgetBytes *int64 `json:"budget_bytes,omitempty"`
}

// EstimateInput is POST /v1/cloud/estimate.
type EstimateInput struct {
	Bytes     int64 `json:"bytes"`
	Receivers int   `json:"receivers"`
}

// Estimate is what the consent dialog shows.
type Estimate struct {
	StorageBytes   int64    `json:"storage_bytes"`
	EgressBytes    int64    `json:"egress_bytes"`
	RetentionHours int      `json:"retention_hours"`
	Cost           *float64 `json:"cost"`
	Currency       string   `json:"currency,omitempty"`
	BudgetBytes    int64    `json:"budget_bytes"`
	UsedBytes      int64    `json:"used_bytes"`
	WithinBudget   bool     `json:"within_budget"`
}

var (
	errCloudOff         = errf(http.StatusNotFound, "cloud_unavailable", "Cloud Distribution is not available on this server.")
	errCloudAccount     = errf(http.StatusForbidden, "cloud_requires_account", "Sign in to use Cloud transfer.")
	errCloudConsent     = errf(http.StatusForbidden, "cloud_consent_required", "Turn on Cloud Distribution and consent first.")
	errCloudBudget      = errf(http.StatusForbidden, "cloud_budget_exhausted", "This month's Cloud budget is used up.")
	errCloudNotFound    = errf(http.StatusNotFound, "not_found", "No such cloud object.")
	errCloudPart        = errf(http.StatusBadRequest, "invalid_part", "The part number or size does not match the object.")
	errCloudState       = errf(http.StatusConflict, "invalid_state", "The cloud object is not in a state that allows this.")
	errCloudIncomplete  = errf(http.StatusConflict, "parts_missing", "Upload every part before sealing the object.")
	errCloudBudgetValue = errf(http.StatusBadRequest, "invalid_budget", "The budget is out of range.")
	errCloudEstimate    = errf(http.StatusBadRequest, "invalid_estimate", "Bytes and receivers must be positive.")
	errCloudNotAdded    = errf(http.StatusForbidden, "device_not_added", "Add this device to your account to use Cloud transfer.")
)

func (s *Service) cloudOn() (*CloudConfig, error) {
	if s.cfg.Cloud == nil {
		return nil, errCloudOff
	}
	return s.cfg.Cloud, nil
}

func period(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC) }

func partKey(objectID string, n int) string { return fmt.Sprintf("cloud/%s/%d", objectID, n) }

type settingsRow struct {
	enabled   bool
	consented bool
	budget    int64
}

func (s *Service) settings(ctx context.Context, q pgx.Tx, userID string) (settingsRow, error) {
	c := s.cfg.Cloud
	row := settingsRow{budget: c.DefaultBudget}
	var consentedAt *time.Time
	var err error
	sql := `SELECT enabled, consented_at, budget_bytes FROM cloud_settings WHERE user_id = $1::uuid`
	if q != nil {
		err = q.QueryRow(ctx, sql+` FOR UPDATE`, userID).Scan(&row.enabled, &consentedAt, &row.budget)
	} else {
		err = s.cfg.Pool.QueryRow(ctx, sql, userID).Scan(&row.enabled, &consentedAt, &row.budget)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return settingsRow{budget: c.DefaultBudget}, nil
	}
	row.consented = consentedAt != nil
	return row, err
}

func (s *Service) used(ctx context.Context, userID string) (int64, error) {
	var n int64
	err := s.cfg.Pool.QueryRow(ctx, `SELECT bytes FROM cloud_usage WHERE user_id = $1::uuid AND period = $2`, userID, period(s.now())).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

func (s *Service) pricing() *Pricing {
	c := s.cfg.Cloud
	if c.PriceStorageGBMonth == nil && c.PriceEgressGB == nil {
		return nil
	}
	return &Pricing{Currency: c.Currency, StorageGBMonth: c.PriceStorageGBMonth, EgressGB: c.PriceEgressGB}
}

// CloudSettings returns availability for everyone and the account's settings when signed in.
func (s *Service) CloudSettings(ctx context.Context, id access.Identity) (CloudSettings, error) {
	c := s.cfg.Cloud
	if c == nil {
		return CloudSettings{Available: false, SignedIn: id.AccountID != ""}, nil
	}
	out := CloudSettings{Available: true, SignedIn: id.AccountID != "", DeviceAdded: id.AccountID != "" && id.DeviceAdded,
		MaxBudget: c.MaxBudget, TTLHours: int(c.TTL.Hours()), Pricing: s.pricing()}
	if id.AccountID == "" {
		return out, nil
	}
	row, err := s.settings(ctx, nil, id.AccountID)
	if err != nil {
		return out, err
	}
	used, err := s.used(ctx, id.AccountID)
	if err != nil {
		return out, err
	}
	out.Enabled, out.Consented, out.BudgetBytes, out.UsedBytes = row.enabled, row.consented, row.budget, used
	return out, nil
}

// PutCloudSettings turns Cloud Distribution on or off and sets the budget. Turning it on needs explicit consent once;
// a raised budget lifts the pause on the account's objects.
func (s *Service) PutCloudSettings(ctx context.Context, id access.Identity, in CloudSettingsInput) (CloudSettings, error) {
	c, err := s.cloudOn()
	if err != nil {
		return CloudSettings{}, err
	}
	if in.BudgetBytes != nil && (*in.BudgetBytes < 0 || *in.BudgetBytes > c.MaxBudget) {
		return CloudSettings{}, errCloudBudgetValue
	}
	now := s.now()
	tx, err := s.cfg.Pool.Begin(ctx)
	if err != nil {
		return CloudSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cur, err := s.settings(ctx, tx, id.AccountID)
	if err != nil {
		return CloudSettings{}, err
	}
	if in.Enabled && !cur.consented && !in.Consent {
		return CloudSettings{}, errCloudConsent
	}
	budget := cur.budget
	if in.BudgetBytes != nil {
		budget = *in.BudgetBytes
	}
	var consentedAt any
	if in.Consent || cur.consented {
		consentedAt = now
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cloud_settings (user_id, enabled, consented_at, budget_bytes, updated_at)
		VALUES ($1::uuid, $2, $3, $4, $5)
		ON CONFLICT (user_id) DO UPDATE SET enabled = $2, consented_at = COALESCE(cloud_settings.consented_at, $3),
			budget_bytes = $4, updated_at = $5`, id.AccountID, in.Enabled, consentedAt, budget, now); err != nil {
		return CloudSettings{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CloudSettings{}, err
	}
	if in.Consent && !cur.consented {
		s.cm.consents.Inc()
	}
	if budget > cur.budget {
		s.unpauseAll(ctx, id.AccountID)
	}
	return s.CloudSettings(ctx, id)
}

// EstimateCloud computes temporary storage, receiver egress and the cost from configured pricing.
func (s *Service) EstimateCloud(ctx context.Context, id access.Identity, in EstimateInput) (Estimate, error) {
	c, err := s.cloudOn()
	if err != nil {
		return Estimate{}, err
	}
	if in.Bytes < 0 || in.Bytes > MaxCloudObjectBytes || in.Receivers < 1 || in.Receivers > 5 {
		return Estimate{}, errCloudEstimate
	}
	parts := partCount(in.Bytes, c.PartSize)
	storage := in.Bytes + int64(parts*PartOverhead)
	egress := storage * int64(in.Receivers)
	out := Estimate{StorageBytes: storage, EgressBytes: egress, RetentionHours: int(c.TTL.Hours())}
	if p := s.pricing(); p != nil {
		gb := func(b int64) float64 { return float64(b) / float64(int64(1)<<30) }
		cost := 0.0
		if p.StorageGBMonth != nil {
			cost += gb(storage) * *p.StorageGBMonth * c.TTL.Hours() / (30 * 24)
		}
		if p.EgressGB != nil {
			cost += gb(egress) * *p.EgressGB
		}
		cost = math.Ceil(cost*10000) / 10000
		out.Cost, out.Currency = &cost, p.Currency
	}
	row, err := s.settings(ctx, nil, id.AccountID)
	if err != nil {
		return out, err
	}
	used, err := s.used(ctx, id.AccountID)
	if err != nil {
		return out, err
	}
	out.BudgetBytes, out.UsedBytes = row.budget, used
	out.WithinBudget = used+storage+egress <= row.budget
	s.cm.estimates.Inc()
	return out, nil
}

func partCount(size int64, partSize int) int {
	if size <= 0 {
		return 1
	}
	return int((size + int64(partSize) - 1) / int64(partSize))
}

func (o CloudObject) partBytes(n int) int {
	if n < o.PartCount-1 {
		return o.PartSize + PartOverhead
	}
	return int(o.Size-int64(n)*int64(o.PartSize)) + PartOverhead
}

const cloudCols = `o.id::text, o.session_id::text, o.file_id::text, o.status, o.paused, o.size, o.part_size, o.part_count,
	(SELECT count(*) FROM cloud_object_parts p WHERE p.object_id = o.id), o.created_at, o.expires_at`

func scanObject(row pgx.Row) (CloudObject, string, string, error) {
	var o CloudObject
	var ownerUser, ownerDevice string
	err := row.Scan(&o.ID, &o.SessionID, &o.FileID, &o.Status, &o.Paused, &o.Size, &o.PartSize, &o.PartCount, &o.PartsUploaded,
		&o.CreatedAt, &o.ExpiresAt, &ownerUser, &ownerDevice)
	if errors.Is(err, pgx.ErrNoRows) {
		return o, "", "", errCloudNotFound
	}
	o.CiphertextSize = o.Size + int64(o.PartCount*PartOverhead)
	return o, ownerUser, ownerDevice, err
}

func (s *Service) object(ctx context.Context, objectID string) (CloudObject, string, string, error) {
	if !sharing.ValidID(objectID) {
		return CloudObject{}, "", "", errCloudNotFound
	}
	return scanObject(s.cfg.Pool.QueryRow(ctx, `SELECT `+cloudCols+`, o.owner_user_id::text, o.owner_device_id::text
		FROM cloud_objects o WHERE o.id = $1::uuid`, objectID))
}

// Distribute starts Cloud Distribution of a shared file for its signed-in sender (idempotent per file).
func (s *Service) Distribute(ctx context.Context, id access.Identity, fileID string) (CloudObject, bool, error) {
	c, err := s.cloudOn()
	if err != nil {
		return CloudObject{}, false, err
	}
	if id.AccountID == "" {
		return CloudObject{}, false, errCloudAccount
	}
	// A signed-in device that is not added to the account (a shared computer) is read-only (docs/SECURITY_MODEL.md §7).
	if !id.DeviceAdded {
		return CloudObject{}, false, errCloudNotAdded
	}
	if !sharing.ValidID(fileID) {
		return CloudObject{}, false, errNotFound
	}
	var sessionID string
	var size int64
	err = s.cfg.Pool.QueryRow(ctx, `SELECT session_id::text, size FROM shared_files WHERE id = $1::uuid`, fileID).Scan(&sessionID, &size)
	if errors.Is(err, pgx.ErrNoRows) {
		return CloudObject{}, false, errNotFound
	}
	if err != nil {
		return CloudObject{}, false, err
	}
	m, err := s.cfg.Sessions.Member(ctx, id.DeviceID, sessionID)
	if err != nil || m.Role != "sender" {
		return CloudObject{}, false, errNotFound
	}
	if !m.Live() {
		return CloudObject{}, false, errEnded
	}
	row, err := s.settings(ctx, nil, id.AccountID)
	if err != nil {
		return CloudObject{}, false, err
	}
	if !row.enabled || !row.consented {
		return CloudObject{}, false, errCloudConsent
	}
	existing, owner, _, err := scanObject(s.cfg.Pool.QueryRow(ctx, `SELECT `+cloudCols+`, o.owner_user_id::text, o.owner_device_id::text
		FROM cloud_objects o WHERE o.file_id = $1::uuid AND o.status <> 'DELETED'`, fileID))
	if err == nil {
		if owner != id.AccountID {
			return CloudObject{}, false, errCloudState
		}
		return existing, false, nil
	}
	if !errors.Is(err, errCloudNotFound) {
		return CloudObject{}, false, err
	}
	used, err := s.used(ctx, id.AccountID)
	if err != nil {
		return CloudObject{}, false, err
	}
	parts := partCount(size, c.PartSize)
	if used+size+int64(parts*PartOverhead) > row.budget {
		s.cm.exhausted.Inc()
		return CloudObject{}, false, errCloudBudget
	}
	now := s.now()
	oid := newObjectID()
	tag, err := s.cfg.Pool.Exec(ctx, `INSERT INTO cloud_objects (id, session_id, file_id, owner_user_id, owner_device_id, status,
		size, part_size, part_count, created_at, expires_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'UPLOADING', $6, $7, $8, $9, $10)
		ON CONFLICT (file_id) WHERE status <> 'DELETED' DO NOTHING`,
		oid, sessionID, fileID, id.AccountID, id.DeviceID, size, c.PartSize, parts, now, now.Add(c.TTL))
	if err != nil {
		return CloudObject{}, false, err
	}
	if tag.RowsAffected() == 0 {
		// A concurrent distribute of the same file won: answer with its object.
		o, owner, _, err := scanObject(s.cfg.Pool.QueryRow(ctx, `SELECT `+cloudCols+`, o.owner_user_id::text, o.owner_device_id::text
			FROM cloud_objects o WHERE o.file_id = $1::uuid AND o.status <> 'DELETED'`, fileID))
		if err == nil && owner != id.AccountID {
			return CloudObject{}, false, errCloudState
		}
		return o, false, err
	}
	s.cm.objects.Inc()
	o, _, _, err := s.object(ctx, oid)
	if err == nil {
		s.notifyCloud(ctx, o)
	}
	return o, true, err
}

func newObjectID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (s *Service) limitPart(deviceID string) error {
	if l := s.cfg.Cloud.PartLimit; l != nil {
		if ok, wait := l.Allow("cloud:" + deviceID); !ok {
			return &Error{Status: http.StatusTooManyRequests, Code: "rate_limited", Msg: "Too many cloud requests.", Wait: wait}
		}
	}
	return nil
}

// charge adds n bytes to the owner's monthly usage, refusing past the budget. On refusal the object is paused and
// participants are told; a later successful charge lifts the pause.
func (s *Service) charge(ctx context.Context, o CloudObject, ownerUser string, n int64) error {
	tx, err := s.cfg.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := s.settings(ctx, tx, ownerUser)
	if err != nil {
		return err
	}
	p := period(s.now())
	if _, err := tx.Exec(ctx, `INSERT INTO cloud_usage (user_id, period, bytes) VALUES ($1::uuid, $2, 0) ON CONFLICT DO NOTHING`, ownerUser, p); err != nil {
		return err
	}
	var used int64
	if err := tx.QueryRow(ctx, `SELECT bytes FROM cloud_usage WHERE user_id = $1::uuid AND period = $2 FOR UPDATE`, ownerUser, p).Scan(&used); err != nil {
		return err
	}
	if used+n > row.budget {
		_ = tx.Rollback(ctx)
		s.cm.exhausted.Inc()
		s.setPaused(ctx, o, true)
		return errCloudBudget
	}
	if _, err := tx.Exec(ctx, `UPDATE cloud_usage SET bytes = bytes + $3 WHERE user_id = $1::uuid AND period = $2`, ownerUser, p, n); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if o.Paused {
		s.setPaused(ctx, o, false)
	}
	return nil
}

func (s *Service) setPaused(ctx context.Context, o CloudObject, paused bool) {
	tag, err := s.cfg.Pool.Exec(ctx, `UPDATE cloud_objects SET paused = $2 WHERE id = $1::uuid AND paused <> $2 AND status <> 'DELETED'`, o.ID, paused)
	if err != nil || tag.RowsAffected() == 0 {
		return
	}
	if fresh, _, _, err := s.object(ctx, o.ID); err == nil {
		s.notifyCloud(ctx, fresh)
	}
}

func (s *Service) unpauseAll(ctx context.Context, userID string) {
	rows, err := s.cfg.Pool.Query(ctx, `SELECT id::text FROM cloud_objects WHERE owner_user_id = $1::uuid AND paused AND status <> 'DELETED'`, userID)
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		s.setPaused(ctx, CloudObject{ID: id}, false)
	}
}

// owned loads an object for its owner (the signed-in sender device that created it).
func (s *Service) owned(ctx context.Context, id access.Identity, objectID string) (CloudObject, error) {
	if _, err := s.cloudOn(); err != nil {
		return CloudObject{}, err
	}
	if id.AccountID == "" {
		return CloudObject{}, errCloudAccount
	}
	o, user, dev, err := s.object(ctx, objectID)
	if err != nil {
		return o, err
	}
	if user != id.AccountID || dev != id.DeviceID {
		return CloudObject{}, errCloudNotFound
	}
	return o, nil
}

// PutPart stores one encrypted part (exact size: part_size or the remainder, plus PartOverhead).
func (s *Service) PutPart(ctx context.Context, id access.Identity, objectID string, n int, body []byte) (CloudObject, error) {
	o, err := s.owned(ctx, id, objectID)
	if err != nil {
		return o, err
	}
	if err := s.limitPart(id.DeviceID); err != nil {
		return o, err
	}
	if o.Status != CloudUploading {
		return o, errCloudState
	}
	if n < 0 || n >= o.PartCount || len(body) != o.partBytes(n) {
		return o, errCloudPart
	}
	// The part row is claimed first, so two concurrent uploads of one part are charged once; a failed charge or store
	// write gives the claim (and the charge) back so a retry can upload it.
	tag, err := s.cfg.Pool.Exec(ctx, `INSERT INTO cloud_object_parts (object_id, part, bytes) VALUES ($1::uuid, $2, $3)
		ON CONFLICT DO NOTHING`, o.ID, n, len(body))
	if err != nil {
		return o, err
	}
	fresh := tag.RowsAffected() == 1
	release := func() {
		_, _ = s.cfg.Pool.Exec(ctx, `DELETE FROM cloud_object_parts WHERE object_id = $1::uuid AND part = $2`, o.ID, n)
	}
	if fresh {
		if err := s.charge(ctx, o, id.AccountID, int64(len(body))); err != nil {
			release()
			return o, err
		}
	}
	if err := s.cfg.Cloud.Store.Put(ctx, partKey(o.ID, n), body); err != nil {
		if fresh {
			release()
			s.refund(ctx, id.AccountID, int64(len(body)))
		}
		return o, err
	}
	if fresh {
		s.cm.uploaded.Add(int64(len(body)))
	}
	o, _, _, err = s.object(ctx, o.ID)
	return o, err
}

// Seal marks a fully uploaded object READY and tells the participants.
func (s *Service) Seal(ctx context.Context, id access.Identity, objectID string) (CloudObject, error) {
	o, err := s.owned(ctx, id, objectID)
	if err != nil {
		return o, err
	}
	if o.Status == CloudReady {
		return o, nil
	}
	if o.Status != CloudUploading {
		return o, errCloudState
	}
	if o.PartsUploaded != o.PartCount {
		return o, errCloudIncomplete
	}
	if _, err := s.cfg.Pool.Exec(ctx, `UPDATE cloud_objects SET status = 'READY', sealed_at = $2 WHERE id = $1::uuid AND status = 'UPLOADING'`, o.ID, s.now()); err != nil {
		return o, err
	}
	o, _, _, err = s.object(ctx, o.ID)
	if err == nil {
		s.notifyCloud(ctx, o)
	}
	return o, err
}

// participant checks the caller is the session's sender or a JOINED receiver.
func (s *Service) cloudParticipant(ctx context.Context, deviceID, sessionID string) (sharing.Member, error) {
	m, err := s.cfg.Sessions.Member(ctx, deviceID, sessionID)
	if err != nil {
		return m, errCloudNotFound
	}
	if m.Role == "receiver" && m.Status != sharing.PJoined {
		return m, errCloudNotFound
	}
	return m, nil
}

// SessionObjects lists the live cloud objects of a session for its participants.
func (s *Service) SessionObjects(ctx context.Context, deviceID, sessionID string) ([]CloudObject, error) {
	if _, err := s.cloudOn(); err != nil {
		return nil, err
	}
	if !sharing.ValidID(sessionID) {
		return nil, errCloudNotFound
	}
	if _, err := s.cloudParticipant(ctx, deviceID, sessionID); err != nil {
		return nil, err
	}
	rows, err := s.cfg.Pool.Query(ctx, `SELECT `+cloudCols+`, o.owner_user_id::text, o.owner_device_id::text
		FROM cloud_objects o WHERE o.session_id = $1::uuid AND o.status <> 'DELETED' ORDER BY o.created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CloudObject{}
	for rows.Next() {
		o, _, _, err := scanObject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Object returns one object for a participant of its session.
func (s *Service) Object(ctx context.Context, deviceID, objectID string) (CloudObject, error) {
	if _, err := s.cloudOn(); err != nil {
		return CloudObject{}, err
	}
	o, _, _, err := s.object(ctx, objectID)
	if err != nil {
		return o, err
	}
	if _, err := s.cloudParticipant(ctx, deviceID, o.SessionID); err != nil {
		return CloudObject{}, err
	}
	return o, nil
}

// GetPart returns one encrypted part of a READY object to a participant, charged to the owner's budget.
func (s *Service) GetPart(ctx context.Context, deviceID, objectID string, n int) ([]byte, error) {
	if _, err := s.cloudOn(); err != nil {
		return nil, err
	}
	o, owner, _, err := s.object(ctx, objectID)
	if err != nil {
		return nil, err
	}
	m, err := s.cloudParticipant(ctx, deviceID, o.SessionID)
	if err != nil {
		return nil, err
	}
	if !m.Live() {
		return nil, errEnded
	}
	if err := s.limitPart(deviceID); err != nil {
		return nil, err
	}
	if o.Status != CloudReady {
		return nil, errCloudState
	}
	if n < 0 || n >= o.PartCount {
		return nil, errCloudPart
	}
	if err := s.charge(ctx, o, owner, int64(o.partBytes(n))); err != nil {
		return nil, err
	}
	b, err := s.cfg.Cloud.Store.Get(ctx, partKey(o.ID, n))
	if err != nil {
		return nil, err
	}
	s.cm.downloaded.Add(int64(len(b)))
	return b, nil
}

// Received records that a joined receiver has the whole file; once every joined receiver has, the object is deleted.
func (s *Service) Received(ctx context.Context, deviceID, objectID string) (CloudObject, error) {
	if _, err := s.cloudOn(); err != nil {
		return CloudObject{}, err
	}
	o, _, _, err := s.object(ctx, objectID)
	if err != nil {
		return o, err
	}
	m, err := s.cloudParticipant(ctx, deviceID, o.SessionID)
	if err != nil {
		return o, err
	}
	if m.Role != "receiver" {
		return o, errReporter
	}
	if o.Status != CloudReady {
		return o, errCloudState
	}
	return s.receipt(ctx, o, m.ParticipantID)
}

// receipt records that a receiver has the file; once every joined receiver has, the object is deleted.
func (s *Service) receipt(ctx context.Context, o CloudObject, participantID string) (CloudObject, error) {
	if _, err := s.cfg.Pool.Exec(ctx, `INSERT INTO cloud_receipts (object_id, participant_id, received_at) VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT DO NOTHING`, o.ID, participantID, s.now()); err != nil {
		return o, err
	}
	var waiting int
	if err := s.cfg.Pool.QueryRow(ctx, `SELECT count(*) FROM session_participants p WHERE p.session_id = $1::uuid
		AND p.role = 'receiver' AND p.status = 'JOINED'
		AND NOT EXISTS (SELECT 1 FROM cloud_receipts r WHERE r.object_id = $2::uuid AND r.participant_id = p.id)`, o.SessionID, o.ID).Scan(&waiting); err != nil {
		return o, err
	}
	if waiting == 0 {
		return s.deleteObject(ctx, o)
	}
	return o, nil
}

// cloudDelivered runs after a receiver's transfer of a file completed (over P2P or from the cloud): it counts as that
// receiver's receipt for the file's live object, so the object goes once every joined receiver has the file.
func (s *Service) cloudDelivered(ctx context.Context, t Transfer) {
	if s.cfg.Cloud == nil {
		return
	}
	o, _, _, err := scanObject(s.cfg.Pool.QueryRow(ctx, `SELECT `+cloudCols+`, o.owner_user_id::text, o.owner_device_id::text
		FROM cloud_objects o WHERE o.file_id = $1::uuid AND o.status <> 'DELETED'`, t.FileID))
	if err != nil {
		return
	}
	if _, err := s.receipt(ctx, o, t.ParticipantID); err != nil && s.cfg.Cloud.Log != nil {
		s.cfg.Cloud.Log.Warn("cloud receipt failed", "error", err.Error())
	}
}

// refund gives back bytes charged for an upload that was not stored.
func (s *Service) refund(ctx context.Context, userID string, n int64) {
	_, _ = s.cfg.Pool.Exec(ctx, `UPDATE cloud_usage SET bytes = GREATEST(0, bytes - $3) WHERE user_id = $1::uuid AND period = $2`,
		userID, period(s.now()), n)
}

// deleteObject removes every stored part and marks the object DELETED.
func (s *Service) deleteObject(ctx context.Context, o CloudObject) (CloudObject, error) {
	for n := 0; n < o.PartCount; n++ {
		if err := s.cfg.Cloud.Store.Delete(ctx, partKey(o.ID, n)); err != nil {
			return o, err
		}
	}
	tag, err := s.cfg.Pool.Exec(ctx, `UPDATE cloud_objects SET status = 'DELETED', deleted_at = $2 WHERE id = $1::uuid AND status <> 'DELETED'`, o.ID, s.now())
	if err != nil {
		return o, err
	}
	if _, err := s.cfg.Pool.Exec(ctx, `DELETE FROM cloud_object_parts WHERE object_id = $1::uuid`, o.ID); err != nil {
		return o, err
	}
	o.Status, o.PartsUploaded = CloudDeleted, 0
	if tag.RowsAffected() > 0 {
		s.cm.deleted.Inc()
		s.notifyCloud(ctx, o)
	}
	return o, nil
}

// SweepCloud deletes objects past their TTL and objects of sessions that ended.
func (s *Service) SweepCloud(ctx context.Context) (int, error) {
	if s.cfg.Cloud == nil {
		return 0, nil
	}
	rows, err := s.cfg.Pool.Query(ctx, `SELECT `+cloudCols+`, o.owner_user_id::text, o.owner_device_id::text
		FROM cloud_objects o JOIN share_sessions ss ON ss.id = o.session_id
		WHERE o.status <> 'DELETED' AND (o.expires_at <= $1 OR ss.status NOT IN ('WAITING', 'ACTIVE'))`, s.now())
	if err != nil {
		return 0, err
	}
	var due []CloudObject
	for rows.Next() {
		o, _, _, err := scanObject(rows)
		if err != nil {
			rows.Close()
			return 0, err
		}
		due = append(due, o)
	}
	rows.Close()
	n := 0
	for _, o := range due {
		if _, err := s.deleteObject(ctx, o); err != nil {
			return n, err
		}
		n++
	}
	s.unpauseWithinBudget(ctx)
	return n, nil
}

// unpauseWithinBudget lifts the pause of objects whose owner is under budget again (the month turned).
func (s *Service) unpauseWithinBudget(ctx context.Context) {
	rows, err := s.cfg.Pool.Query(ctx, `SELECT DISTINCT owner_user_id::text FROM cloud_objects WHERE paused AND status <> 'DELETED'`)
	if err != nil {
		return
	}
	var owners []string
	for rows.Next() {
		var u string
		if rows.Scan(&u) == nil {
			owners = append(owners, u)
		}
	}
	rows.Close()
	for _, u := range owners {
		row, err := s.settings(ctx, nil, u)
		if err != nil {
			continue
		}
		if used, err := s.used(ctx, u); err == nil && used < row.budget {
			s.unpauseAll(ctx, u)
		}
	}
}

// RunCloud sweeps every interval until ctx ends.
func (s *Service) RunCloud(ctx context.Context, interval time.Duration) {
	if s.cfg.Cloud == nil {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, err := s.SweepCloud(ctx); err != nil && s.cfg.Cloud.Log != nil {
				s.cfg.Cloud.Log.Warn("cloud sweep failed", "error", err.Error())
			}
		}
	}
}

// notifyCloud sends CLOUD_UPDATED to the sender and every JOINED receiver of the object's session.
func (s *Service) notifyCloud(ctx context.Context, o CloudObject) {
	rows, err := s.cfg.Pool.Query(ctx, `SELECT device_id::text FROM session_participants
		WHERE session_id = $1::uuid AND (role = 'sender' OR status = 'JOINED')`, o.SessionID)
	if err != nil {
		return
	}
	defer rows.Close()
	ev := CloudEvent{Type: "CLOUD_UPDATED", SessionID: o.SessionID, Object: o}
	for rows.Next() {
		var dev string
		if rows.Scan(&dev) == nil {
			s.cfg.Notify.SendToDevice(dev, ev)
		}
	}
}
