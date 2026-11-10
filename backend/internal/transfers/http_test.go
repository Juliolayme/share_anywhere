package transfers

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

type tokenIsDevice struct{}

func (tokenIsDevice) Verify(_ context.Context, tok string) (access.Identity, error) {
	if !sharing.ValidID(tok) {
		return access.Identity{}, access.ErrTokenInvalid
	}
	return access.Identity{DeviceID: tok}, nil
}

func (e *env) mux() *http.ServeMux {
	mux := http.NewServeMux()
	r := access.NewRouter(mux, tokenIsDevice{})
	NewHTTP(e.svc, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(r)
	r.Finalize()
	return mux
}

func call(mux *http.ServeMux, method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestTransferHTTP(t *testing.T) {
	e := newEnv(t, 1000)
	mux := e.mux()
	sender, rx, other, stranger := e.device("Minh"), e.device("Lan"), e.device("Huy"), e.device("Stranger")
	s := e.session(sender, false)
	e.join(rx, s.Code)
	e.join(other, s.Code)

	rec := call(mux, "GET", "/v1/sessions/"+s.ID+"/transfers", rx.DeviceID, "")
	var l List
	_ = json.Unmarshal(rec.Body.Bytes(), &l)
	if rec.Code != 200 || len(l.Transfers) != 2 || l.Capability == "" {
		t.Fatalf("list %d %s", rec.Code, rec.Body)
	}
	id := byFile(l, 1000).ID
	ol, _ := e.svc.List(ctx, other.DeviceID, s.ID)
	otherID := ol.Transfers[0].ID

	// Access matrix: no token → 401; stranger and the other receiver → 404 (existence hidden).
	for _, c := range []struct {
		method, path, token, body string
		want                      int
	}{
		{"GET", "/v1/sessions/" + s.ID + "/transfers", "", "", 401},
		{"GET", "/v1/sessions/" + s.ID + "/transfers", stranger.DeviceID, "", 404},
		{"GET", "/v1/sessions/" + s.ID + "/files", stranger.DeviceID, "", 404},
		{"GET", "/v1/sessions/" + s.ID + "/files", rx.DeviceID, "", 200},
		{"GET", "/v1/transfers/" + id, "", "", 401},
		{"GET", "/v1/transfers/" + id, stranger.DeviceID, "", 404},
		{"GET", "/v1/transfers/" + otherID, rx.DeviceID, "", 404},
		{"GET", "/v1/transfers/" + otherID, sender.DeviceID, "", 200},
		{"GET", "/v1/transfers/not-a-uuid", rx.DeviceID, "", 404},
		{"POST", "/v1/transfers/" + otherID + "/report", rx.DeviceID, `{"status":"CONNECTING","verified_bytes":0}`, 404},
		{"POST", "/v1/transfers/" + otherID + "/pause", rx.DeviceID, "", 404},
		{"POST", "/v1/transfers/" + id + "/report", rx.DeviceID, `not json`, 400},
		{"POST", "/v1/transfers/" + id + "/report", rx.DeviceID, `{"status":"CONNECTING","verified_bytes":0,"extra":1}`, 400},
		{"POST", "/v1/transfers/" + id + "/report", rx.DeviceID, `{"status":"CONNECTING","verified_bytes":0,"route":"direct"}`, 200},
		{"POST", "/v1/transfers/" + id + "/report", rx.DeviceID, `{"status":"COMPLETED","verified_bytes":1000}`, 409},
		{"POST", "/v1/transfers/" + id + "/pause", sender.DeviceID, "", 200},
		{"POST", "/v1/transfers/" + id + "/resume", rx.DeviceID, "", 403},
		{"POST", "/v1/transfers/" + id + "/resume", rx.DeviceID, `{"capability":"` + l.Capability + `"}`, 200},
		{"POST", "/v1/transfers/" + id + "/cancel", rx.DeviceID, "", 200},
		{"PUT", "/v1/transfers/" + id + "/cancel", rx.DeviceID, "", 405},
	} {
		if rec := call(mux, c.method, c.path, c.token, c.body); rec.Code != c.want {
			t.Errorf("%s %s as %.8s: want %d, got %d %s", c.method, c.path, c.token, c.want, rec.Code, rec.Body)
		}
	}
	// Rate limiting answers 429 with Retry-After.
	e2 := newEnv(t, 1)
	m2 := e2.mux()
	snd2, rx2 := e2.device("A"), e2.device("B")
	s2 := e2.session(snd2, false)
	e2.join(rx2, s2.Code)
	l2, _ := e2.svc.List(ctx, rx2.DeviceID, s2.ID)
	call(m2, "POST", "/v1/transfers/"+l2.Transfers[0].ID+"/report", rx2.DeviceID, `{"status":"CONNECTING","verified_bytes":0}`)
	rec = call(m2, "POST", "/v1/transfers/"+l2.Transfers[0].ID+"/report", rx2.DeviceID, `{"status":"CONNECTING","verified_bytes":0}`)
	if rec.Code != 429 || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("rate limit: %d %v", rec.Code, rec.Header())
	}
}
