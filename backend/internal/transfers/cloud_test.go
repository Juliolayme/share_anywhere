package transfers

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/objectstore"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// countingStore wraps a store and counts live keys (the S3 gateway in CI, memory elsewhere).
type countingStore struct {
	objectstore.Store
	live map[string]bool
}

func (c *countingStore) Put(ctx context.Context, k string, b []byte) error {
	c.live[k] = true
	return c.Store.Put(ctx, k, b)
}

func (c *countingStore) Delete(ctx context.Context, k string) error {
	delete(c.live, k)
	return c.Store.Delete(ctx, k)
}

// cloudStore is the S3-compatible gateway of the CI backend job (TEST_S3_ENDPOINT), else the memory adapter.
func cloudStore(t *testing.T) *countingStore {
	t.Helper()
	if ep := os.Getenv("TEST_S3_ENDPOINT"); ep != "" {
		s3 := &objectstore.S3{Endpoint: ep, Region: "us-east-1", Bucket: "sa-cloud-test", AccessKey: os.Getenv("TEST_S3_ACCESS_KEY"),
			SecretKey: os.Getenv("TEST_S3_SECRET_KEY")}
		if err := s3.EnsureBucket(ctx); err != nil {
			t.Fatal(err)
		}
		return &countingStore{Store: s3, live: map[string]bool{}}
	}
	return &countingStore{Store: objectstore.NewMemory(), live: map[string]bool{}}
}

type cloudEnv struct {
	*env
	store *countingStore
}

func newCloudEnv(t *testing.T, mutate func(*CloudConfig)) *cloudEnv {
	e := newEnv(t, 1000)
	store := cloudStore(t)
	c := &CloudConfig{Store: store, TTL: 2 * time.Hour, PartSize: 256, DefaultBudget: 1 << 20, MaxBudget: 1 << 30, Currency: "USD",
		PartLimit: ratelimit.New(ratelimit.Rule{Limit: 1000, Window: time.Minute}, e.clk)}
	if mutate != nil {
		mutate(c)
	}
	e.svc = New(Config{Pool: e.pool, Clock: e.clk, Sessions: e.share, Notify: e.note, Metrics: e.reg,
		ReportLimit: ratelimit.New(ratelimit.Rule{Limit: 1000, Window: time.Minute}, e.clk), Cloud: c})
	return &cloudEnv{env: e, store: store}
}

// account creates a user and returns the identity of a device signed in to it.
func (e *cloudEnv) account(c sharing.Caller) access.Identity {
	e.t.Helper()
	uid := newObjectID()
	if _, err := e.pool.Exec(ctx, `INSERT INTO users (id, email, password_hash) VALUES ($1::uuid, $2, 'x')`, uid,
		fmt.Sprintf("u%s@example.test", uid[:8])); err != nil {
		e.t.Fatal(err)
	}
	return access.Identity{DeviceID: c.DeviceID, AccountID: uid, DeviceAdded: true}
}

func (e *cloudEnv) consent(id access.Identity, budget int64) {
	e.t.Helper()
	if _, err := e.svc.PutCloudSettings(ctx, id, CloudSettingsInput{Enabled: true, Consent: true, BudgetBytes: &budget}); err != nil {
		e.t.Fatal(err)
	}
}

func fileOf(t *testing.T, e *env, sessionID string, size int64) string {
	t.Helper()
	var id string
	if err := e.pool.QueryRow(ctx, `SELECT id::text FROM shared_files WHERE session_id = $1::uuid AND size = $2`, sessionID, size).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func cipherPart(o CloudObject, n int) []byte {
	b := make([]byte, o.partBytes(n))
	_, _ = rand.Read(b)
	return b
}

// upload stores every part of o and seals it; returns the parts as uploaded.
func (e *cloudEnv) upload(id access.Identity, o CloudObject) [][]byte {
	e.t.Helper()
	parts := make([][]byte, o.PartCount)
	for n := range parts {
		parts[n] = cipherPart(o, n)
		if _, err := e.svc.PutPart(ctx, id, o.ID, n, parts[n]); err != nil {
			e.t.Fatalf("part %d: %v", n, err)
		}
	}
	if _, err := e.svc.Seal(ctx, id, o.ID); err != nil {
		e.t.Fatal(err)
	}
	return parts
}

func (e *cloudEnv) cloudEvents(device string) (out []CloudObject) {
	e.note.mu.Lock()
	defer e.note.mu.Unlock()
	for _, v := range e.note.ev[device] {
		if c, ok := v.(CloudEvent); ok && c.Type == "CLOUD_UPDATED" {
			out = append(out, c.Object)
		}
	}
	return out
}

func TestCloudPreconditions(t *testing.T) {
	e := newCloudEnv(t, nil)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	fid := fileOf(t, e.env, s.ID, 1000)

	// A guest sender: 403 cloud_requires_account (docs/PRODUCT_REQUIREMENTS.md §6.6).
	_, _, err := e.svc.Distribute(ctx, access.Identity{DeviceID: sender.DeviceID}, fid)
	wantCode(t, err, "cloud_requires_account")
	guest, err := e.svc.CloudSettings(ctx, access.Identity{DeviceID: rx.DeviceID})
	if err != nil || !guest.Available || guest.SignedIn || guest.Enabled {
		t.Fatalf("guest settings %+v %v", guest, err)
	}

	id := e.account(sender)
	// Signed in without consent: 403 cloud_consent_required, and enabling needs the consent flag.
	_, _, err = e.svc.Distribute(ctx, id, fid)
	wantCode(t, err, "cloud_consent_required")
	_, err = e.svc.PutCloudSettings(ctx, id, CloudSettingsInput{Enabled: true})
	wantCode(t, err, "cloud_consent_required")
	big := int64(1) << 40
	_, err = e.svc.PutCloudSettings(ctx, id, CloudSettingsInput{Enabled: true, Consent: true, BudgetBytes: &big})
	wantCode(t, err, "invalid_budget")
	e.consent(id, 1<<20)
	st, err := e.svc.CloudSettings(ctx, id)
	if err != nil || !st.Enabled || !st.Consented || st.BudgetBytes != 1<<20 || st.Pricing != nil || st.TTLHours != 2 {
		t.Fatalf("settings %+v %v", st, err)
	}
	// Turning it off and on again needs no second consent.
	if _, err := e.svc.PutCloudSettings(ctx, id, CloudSettingsInput{Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.PutCloudSettings(ctx, id, CloudSettingsInput{Enabled: true}); err != nil {
		t.Fatal(err)
	}

	// Only the session's sender distributes its files.
	rxID := e.account(rx)
	e.consent(rxID, 1<<20)
	_, _, err = e.svc.Distribute(ctx, rxID, fid)
	wantCode(t, err, "not_found")

	// No pricing configured: the estimate has no cost ("cost unknown" in the clients).
	est, err := e.svc.EstimateCloud(ctx, id, EstimateInput{Bytes: 1000, Receivers: 2})
	if err != nil || est.Cost != nil || est.StorageBytes != 1000+4*PartOverhead || est.EgressBytes != 2*est.StorageBytes || !est.WithinBudget {
		t.Fatalf("estimate %+v %v", est, err)
	}
	_, err = e.svc.EstimateCloud(ctx, id, EstimateInput{Bytes: 10, Receivers: 0})
	wantCode(t, err, "invalid_estimate")

	// Cloud off on the server: settings say unavailable, the rest is 404 cloud_unavailable.
	off := New(Config{Pool: e.pool, Clock: e.clk, Sessions: e.share, Notify: e.note, Metrics: e.reg})
	if st, _ := off.CloudSettings(ctx, id); st.Available {
		t.Fatal("cloud must be unavailable without configuration")
	}
	_, _, err = off.Distribute(ctx, id, fid)
	wantCode(t, err, "cloud_unavailable")
}

func TestCloudPricedEstimate(t *testing.T) {
	storage, egress := 0.02, 0.09
	e := newCloudEnv(t, func(c *CloudConfig) {
		c.PriceStorageGBMonth, c.PriceEgressGB, c.TTL, c.PartSize = &storage, &egress, 30*24*time.Hour, 1<<30
	})
	id := e.account(e.device("Minh"))
	est, err := e.svc.EstimateCloud(ctx, id, EstimateInput{Bytes: 1 << 30, Receivers: 2})
	if err != nil || est.Cost == nil || est.Currency != "USD" {
		t.Fatalf("estimate %+v %v", est, err)
	}
	// ~1 GiB stored for a month plus ~2 GiB egress: 0.02 + 0.18.
	if *est.Cost < 0.2 || *est.Cost > 0.2001 {
		t.Fatalf("cost %v", *est.Cost)
	}
}

func TestCloudUploadDownloadAndDeleteAfterDelivery(t *testing.T) {
	e := newCloudEnv(t, nil)
	sender, rx, rx2, outsider := e.device("Minh"), e.device("Lan"), e.device("Huy"), e.device("Stranger")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	e.join(rx2, s.Code)
	id := e.account(sender)
	e.consent(id, 1<<20)
	fid := fileOf(t, e.env, s.ID, 1000)

	o, created, err := e.svc.Distribute(ctx, id, fid)
	if err != nil || !created || o.Status != CloudUploading || o.PartCount != 4 || o.PartSize != 256 || o.CiphertextSize != 1000+4*PartOverhead {
		t.Fatalf("distribute %+v %v", o, err)
	}
	again, created, err := e.svc.Distribute(ctx, id, fid)
	if err != nil || created || again.ID != o.ID {
		t.Fatal("distribute is idempotent per file")
	}
	// Exact part sizes only; the last part carries the remainder.
	if _, err := e.svc.PutPart(ctx, id, o.ID, 0, make([]byte, 10)); err == nil {
		t.Fatal("a short part must be refused")
	}
	if _, err := e.svc.PutPart(ctx, id, o.ID, 4, make([]byte, 256+PartOverhead)); err == nil {
		t.Fatal("a part past the end must be refused")
	}
	// Only the owner device uploads, and receivers cannot read before READY.
	if _, err := e.svc.PutPart(ctx, access.Identity{DeviceID: rx.DeviceID, AccountID: id.AccountID}, o.ID, 0, cipherPart(o, 0)); err == nil {
		t.Fatal("another device must not upload")
	}
	if _, err := e.svc.GetPart(ctx, rx.DeviceID, o.ID, 0); err == nil {
		t.Fatal("parts are readable only once sealed")
	}
	if _, err := e.svc.PutPart(ctx, id, o.ID, 0, cipherPart(o, 0)); err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.Seal(ctx, id, o.ID)
	wantCode(t, err, "parts_missing")
	parts := make([][]byte, o.PartCount)
	for n := range parts {
		parts[n] = cipherPart(o, n)
		if _, err := e.svc.PutPart(ctx, id, o.ID, n, parts[n]); err != nil {
			t.Fatal(err)
		}
	}
	sealed, err := e.svc.Seal(ctx, id, o.ID)
	if err != nil || sealed.Status != CloudReady || sealed.PartsUploaded != 4 {
		t.Fatalf("seal %+v %v", sealed, err)
	}
	if evs := e.cloudEvents(rx.DeviceID); len(evs) == 0 || evs[len(evs)-1].Status != CloudReady {
		t.Fatalf("joined receivers hear CLOUD_UPDATED READY: %+v", evs)
	}

	// A guest receiver who joined lists and downloads; a stranger cannot.
	list, err := e.svc.SessionObjects(ctx, rx.DeviceID, s.ID)
	if err != nil || len(list) != 1 || list[0].ID != o.ID {
		t.Fatalf("session objects %+v %v", list, err)
	}
	if _, err := e.svc.SessionObjects(ctx, outsider.DeviceID, s.ID); err == nil {
		t.Fatal("a stranger must not list objects")
	}
	if _, err := e.svc.GetPart(ctx, outsider.DeviceID, o.ID, 0); err == nil {
		t.Fatal("a stranger must not download")
	}
	for n := range parts {
		b, err := e.svc.GetPart(ctx, rx.DeviceID, o.ID, n)
		if err != nil || !bytes.Equal(b, parts[n]) {
			t.Fatalf("part %d: %v", n, err)
		}
	}
	if _, err := e.svc.Received(ctx, sender.DeviceID, o.ID); err == nil {
		t.Fatal("only receivers record receipt")
	}
	after, err := e.svc.Received(ctx, rx.DeviceID, o.ID)
	if err != nil || after.Status != CloudReady {
		t.Fatalf("one of two receivers: object stays %+v %v", after, err)
	}
	gone, err := e.svc.Received(ctx, rx2.DeviceID, o.ID)
	if err != nil || gone.Status != CloudDeleted {
		t.Fatalf("every joined receiver has it: deleted %+v %v", gone, err)
	}
	if len(e.store.live) != 0 {
		t.Fatalf("stored parts left after delivery: %v", e.store.live)
	}
	if _, err := e.svc.GetPart(ctx, rx.DeviceID, o.ID, 0); err == nil {
		t.Fatal("a deleted object cannot be downloaded")
	}
	// Usage: uploads (part 0 counted once) plus the downloads of one receiver.
	st, _ := e.svc.CloudSettings(ctx, id)
	if st.UsedBytes != 2*o.CiphertextSize {
		t.Fatalf("used %d, want %d", st.UsedBytes, 2*o.CiphertextSize)
	}
}

func TestCloudBudgetPausesAndResumes(t *testing.T) {
	e := newCloudEnv(t, nil)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	id := e.account(sender)
	fid := fileOf(t, e.env, s.ID, 1000)
	cipher := int64(1000 + 4*PartOverhead)

	e.consent(id, cipher-1)
	_, _, err := e.svc.Distribute(ctx, id, fid)
	wantCode(t, err, "cloud_budget_exhausted")

	// Enough for the upload and half a download.
	e.consent(id, cipher+600)
	o, _, err := e.svc.Distribute(ctx, id, fid)
	if err != nil {
		t.Fatal(err)
	}
	e.upload(id, o)
	if _, err := e.svc.GetPart(ctx, rx.DeviceID, o.ID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.GetPart(ctx, rx.DeviceID, o.ID, 1); err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.GetPart(ctx, rx.DeviceID, o.ID, 2)
	wantCode(t, err, "cloud_budget_exhausted")
	evs := e.cloudEvents(rx.DeviceID)
	if len(evs) == 0 || !evs[len(evs)-1].Paused {
		t.Fatalf("exhaustion pauses the object and tells participants: %+v", evs)
	}
	// A raised budget lifts the pause and the download continues.
	e.consent(id, 1<<20)
	if evs := e.cloudEvents(rx.DeviceID); evs[len(evs)-1].Paused {
		t.Fatal("raising the budget lifts the pause")
	}
	if _, err := e.svc.GetPart(ctx, rx.DeviceID, o.ID, 2); err != nil {
		t.Fatal(err)
	}
}

func TestCloudSweepDeletesExpiredAndEndedSessions(t *testing.T) {
	e := newCloudEnv(t, nil)
	sender, rx := e.device("Minh"), e.device("Lan")
	id := e.account(sender)
	e.consent(id, 1<<20)

	s := e.session(sender, false)
	e.join(rx, s.Code)
	o, _, err := e.svc.Distribute(ctx, id, fileOf(t, e.env, s.ID, 1000))
	if err != nil {
		t.Fatal(err)
	}
	e.upload(id, o)
	s2 := e.session(sender, false)
	o2, _, err := e.svc.Distribute(ctx, id, fileOf(t, e.env, s2.ID, 10))
	if err != nil {
		t.Fatal(err)
	}
	e.upload(id, o2)
	if n, err := e.svc.SweepCloud(ctx); err != nil || n != 0 {
		t.Fatalf("nothing due yet: %d %v", n, err)
	}
	// The second session is closed by its sender: its object goes at the next sweep.
	if err := e.share.Close(ctx, sender, s2.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := e.svc.SweepCloud(ctx); err != nil || n != 1 {
		t.Fatalf("ended session: %d %v", n, err)
	}
	// Past the TTL the first object goes too.
	e.clk.Advance(2*time.Hour + time.Second)
	if n, err := e.svc.SweepCloud(ctx); err != nil || n != 1 {
		t.Fatalf("expired: %d %v", n, err)
	}
	if len(e.store.live) != 0 {
		t.Fatalf("stored parts left: %v", e.store.live)
	}
}

type identities map[string]access.Identity

func (m identities) Verify(_ context.Context, tok string) (access.Identity, error) {
	id, ok := m[tok]
	if !ok {
		return access.Identity{}, access.ErrTokenInvalid
	}
	return id, nil
}

func TestCloudHTTP(t *testing.T) {
	e := newCloudEnv(t, nil)
	sender, rx := e.device("Minh"), e.device("Lan")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	acct := e.account(sender)
	ids := identities{"guest-sender": {DeviceID: sender.DeviceID}, "acct": acct, "rx": {DeviceID: rx.DeviceID}}
	mux := http.NewServeMux()
	r := access.NewRouter(mux, ids)
	NewHTTP(e.svc, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(r)
	r.Finalize()
	do := func(method, path, tok string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		if body != nil && !strings.Contains(path, "/parts/") {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	errCode := func(rec *httptest.ResponseRecorder) string {
		var b struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &b)
		return b.Error
	}
	fid := fileOf(t, e.env, s.ID, 10)
	if rec := do("POST", "/v1/files/"+fid+"/distribute", "guest-sender", nil); rec.Code != 403 || errCode(rec) != "cloud_requires_account" {
		t.Fatalf("guest distribute: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/v1/files/"+fid+"/distribute", "acct", nil); rec.Code != 403 || errCode(rec) != "cloud_consent_required" {
		t.Fatalf("no consent: %d %s", rec.Code, rec.Body)
	}
	if rec := do("PUT", "/v1/cloud/settings", "guest-sender", []byte(`{"enabled":true,"consent":true}`)); rec.Code != 403 || errCode(rec) != "account_required" {
		t.Fatalf("guest settings write: %d %s", rec.Code, rec.Body)
	}
	if rec := do("GET", "/v1/cloud/settings", "guest-sender", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"available":true`) {
		t.Fatalf("guest settings read: %d %s", rec.Code, rec.Body)
	}
	if rec := do("PUT", "/v1/cloud/settings", "acct", []byte(`{"enabled":true,"consent":true,"budget_bytes":100000}`)); rec.Code != 200 {
		t.Fatalf("consent: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/v1/cloud/estimate", "acct", []byte(`{"bytes":10,"receivers":1}`)); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"cost":null`) {
		t.Fatalf("estimate: %d %s", rec.Code, rec.Body)
	}
	rec := do("POST", "/v1/files/"+fid+"/distribute", "acct", nil)
	var o CloudObject
	_ = json.Unmarshal(rec.Body.Bytes(), &o)
	if rec.Code != 201 || o.PartCount != 1 {
		t.Fatalf("distribute: %d %s", rec.Code, rec.Body)
	}
	part := cipherPart(o, 0)
	if rec := do("PUT", "/v1/cloud/objects/"+o.ID+"/parts/0", "acct", append(part, 1)); rec.Code != 400 {
		t.Fatalf("oversized part: %d %s", rec.Code, rec.Body)
	}
	if rec := do("PUT", "/v1/cloud/objects/"+o.ID+"/parts/x", "acct", part); rec.Code != 400 {
		t.Fatalf("bad part number: %d", rec.Code)
	}
	if rec := do("PUT", "/v1/cloud/objects/"+o.ID+"/parts/0", "acct", part); rec.Code != 200 {
		t.Fatalf("part: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/v1/cloud/objects/"+o.ID+"/seal", "acct", nil); rec.Code != 200 {
		t.Fatalf("seal: %d %s", rec.Code, rec.Body)
	}
	if rec := do("GET", "/v1/sessions/"+s.ID+"/cloud", "rx", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), o.ID) {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	if rec := do("GET", "/v1/cloud/objects/"+o.ID, "rx", nil); rec.Code != 200 {
		t.Fatalf("object: %d", rec.Code)
	}
	got := do("GET", "/v1/cloud/objects/"+o.ID+"/parts/0", "rx", nil)
	if got.Code != 200 || !bytes.Equal(got.Body.Bytes(), part) || got.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("download: %d", got.Code)
	}
	if rec := do("POST", "/v1/cloud/objects/"+o.ID+"/received", "rx", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"DELETED"`) {
		t.Fatalf("received: %d %s", rec.Code, rec.Body)
	}
}
