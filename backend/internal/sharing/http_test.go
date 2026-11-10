package sharing

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
)

type tokenIsDevice struct{}

func (tokenIsDevice) Verify(_ context.Context, tok string) (access.Identity, error) {
	if !ValidID(tok) {
		return access.Identity{}, access.ErrTokenInvalid
	}
	return access.Identity{DeviceID: tok}, nil
}

func (e *env) mux() *http.ServeMux {
	mux := http.NewServeMux()
	r := access.NewRouter(mux, tokenIsDevice{})
	NewHTTP(e.svc, clientip.New([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}), func(ctx context.Context, id string) (string, string, error) {
		var name, platform string
		err := e.pool.QueryRow(ctx, `SELECT display_name, platform FROM devices WHERE id = $1::uuid`, id).Scan(&name, &platform)
		return name, platform, err
	}).Register(r)
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
	req.RemoteAddr = "10.0.0.5:1"
	req.Header.Set("X-Forwarded-For", "203.0.113."+token[:2]) // distinct address per device (hex prefix)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestSessionHTTPFlow(t *testing.T) {
	e := newEnv(t)
	mux := e.mux()
	snd, rx := e.device("Sender"), e.device("Receiver")
	rec := call(mux, "POST", "/v1/sessions", snd.DeviceID, `{"files":[{"name":"a.bin","size":5,"mime":"application/octet-stream"}],"require_approval":false}`)
	if rec.Code != 201 {
		t.Fatalf("create %d %s", rec.Code, rec.Body)
	}
	var s SessionView
	_ = json.Unmarshal(rec.Body.Bytes(), &s)
	if s.Code == "" || s.Role != "sender" {
		t.Fatalf("create body %s", rec.Body)
	}
	if rec := call(mux, "POST", "/v1/sessions", snd.DeviceID, `{"files":[]}`); rec.Code != 400 {
		t.Fatalf("empty files: %d", rec.Code)
	}
	if rec := call(mux, "GET", "/v1/sessions/"+s.ID, rx.DeviceID, ""); rec.Code != 404 {
		t.Fatalf("non-participant view must be 404, got %d", rec.Code)
	}
	if rec := call(mux, "POST", "/v1/sessions/resolve-code", rx.DeviceID, `{"code":"12"}`); rec.Code != 400 {
		t.Fatalf("bad code: %d", rec.Code)
	}
	rec = call(mux, "POST", "/v1/sessions/resolve-code", rx.DeviceID, `{"code":"`+s.Code+`"}`)
	var p Preview
	_ = json.Unmarshal(rec.Body.Bytes(), &p)
	if rec.Code != 200 || p.JoinTicket == "" {
		t.Fatalf("resolve %d %s", rec.Code, rec.Body)
	}
	rec = call(mux, "POST", "/v1/sessions/"+s.ID+"/join", rx.DeviceID, `{"ticket":"`+p.JoinTicket+`"}`)
	var jr JoinResult
	_ = json.Unmarshal(rec.Body.Bytes(), &jr)
	if rec.Code != 200 || jr.Participant.Status != PJoined {
		t.Fatalf("join %d %s", rec.Code, rec.Body)
	}
	// Join tickets are single use.
	if rec := call(mux, "POST", "/v1/sessions/"+s.ID+"/join", rx.DeviceID, `{"ticket":"`+p.JoinTicket+`"}`); rec.Code != 410 || !strings.Contains(rec.Body.String(), "join_ticket_invalid") {
		t.Fatalf("reused ticket: %d %s", rec.Code, rec.Body)
	}
	if rec := call(mux, "PATCH", "/v1/sessions/"+s.ID, rx.DeviceID, `{"require_approval":true}`); rec.Code != 403 {
		t.Fatalf("receiver PATCH must be 403, got %d", rec.Code)
	}
	if rec := call(mux, "PATCH", "/v1/sessions/"+s.ID, snd.DeviceID, `{"accepting_receivers":true}`); rec.Code != 400 {
		t.Fatalf("reopen via PATCH must be refused: %d", rec.Code)
	}
	if rec := call(mux, "POST", "/v1/sessions/"+s.ID+"/renew", snd.DeviceID, ""); rec.Code != 200 {
		t.Fatalf("renew %d %s", rec.Code, rec.Body)
	}
	if rec := call(mux, "POST", "/v1/participants/"+jr.Participant.ID+"/block", rx.DeviceID, ""); rec.Code != 403 && rec.Code != 404 {
		t.Fatalf("receiver cannot block: %d", rec.Code)
	}
	if rec := call(mux, "DELETE", "/v1/participants/"+jr.Participant.ID, snd.DeviceID, ""); rec.Code != 200 {
		t.Fatalf("remove %d %s", rec.Code, rec.Body)
	}
	if rec := call(mux, "POST", "/v1/participants/"+jr.Participant.ID+"/leave", rx.DeviceID, ""); rec.Code != 409 {
		t.Fatalf("leave after removal: %d", rec.Code)
	}
	if rec := call(mux, "PUT", "/v1/sessions/"+s.ID, snd.DeviceID, ""); rec.Code != 405 || !strings.Contains(rec.Header().Get("Allow"), "PATCH") {
		t.Fatalf("405 with Allow: %d %v", rec.Code, rec.Header())
	}
	if rec := call(mux, "GET", "/v1/sessions/resolve-code", rx.DeviceID, ""); rec.Code != 405 {
		t.Fatalf("GET on resolve-code: %d", rec.Code)
	}
	if rec := call(mux, "POST", "/v1/sessions/"+s.ID+"/close", snd.DeviceID, ""); rec.Code != 200 {
		t.Fatalf("close %d", rec.Code)
	}
	if rec := call(mux, "GET", "/v1/sessions/not-a-uuid", snd.DeviceID, ""); rec.Code != 404 {
		t.Fatalf("garbage id: %d", rec.Code)
	}
	// 429 carries Retry-After.
	for i := 0; i < 12; i++ {
		rec = call(mux, "POST", "/v1/sessions/resolve-code", rx.DeviceID, `{"code":"123456"}`)
	}
	if rec.Code != 429 || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("rate limited: %d %v", rec.Code, rec.Header())
	}
}

func TestSessionHTTPIDOR(t *testing.T) {
	e := newEnv(t)
	mux := e.mux()
	snd, rx, stranger := e.device("Sender"), e.device("Receiver"), e.device("Stranger")
	rec := call(mux, "POST", "/v1/sessions", snd.DeviceID, `{"files":[{"name":"a","size":1}]}`)
	var s SessionView
	_ = json.Unmarshal(rec.Body.Bytes(), &s)
	rec = call(mux, "POST", "/v1/sessions/resolve-code", rx.DeviceID, `{"code":"`+s.Code+`"}`)
	var p Preview
	_ = json.Unmarshal(rec.Body.Bytes(), &p)
	rec = call(mux, "POST", "/v1/sessions/"+s.ID+"/join", rx.DeviceID, `{"ticket":"`+p.JoinTicket+`"}`)
	var jr JoinResult
	_ = json.Unmarshal(rec.Body.Bytes(), &jr)
	for _, tc := range []struct {
		method, path, who string
		want              int
	}{
		{"POST", "/v1/sessions/" + s.ID + "/close", stranger.DeviceID, 404},
		{"POST", "/v1/sessions/" + s.ID + "/renew", stranger.DeviceID, 404},
		{"PATCH", "/v1/sessions/" + s.ID, stranger.DeviceID, 404},
		{"POST", "/v1/sessions/" + s.ID + "/close", rx.DeviceID, 403},
		{"POST", "/v1/sessions/" + s.ID + "/renew", rx.DeviceID, 403},
		{"POST", "/v1/participants/" + jr.Participant.ID + "/leave", stranger.DeviceID, 404},
		{"DELETE", "/v1/participants/" + jr.Participant.ID, stranger.DeviceID, 404},
		{"POST", "/v1/participants/" + jr.Participant.ID + "/approve", rx.DeviceID, 403},
	} {
		body := ""
		if tc.method == "PATCH" {
			body = `{"require_approval":true}`
		}
		if rec := call(mux, tc.method, tc.path, tc.who, body); rec.Code != tc.want {
			t.Errorf("%s %s: got %d want %d", tc.method, tc.path, rec.Code, tc.want)
		}
	}
}
