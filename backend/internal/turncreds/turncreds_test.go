package turncreds

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" // #nosec G505 -- matches coturn
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// The credential must equal what coturn computes for use-auth-secret: base64(HMAC-SHA1(secret, username)).
func TestSignMatchesCoturnRESTScheme(t *testing.T) {
	exp := time.Unix(1794300000, 0)
	user, cred := Sign([]byte("ci-turn-secret"), "pid-1", exp)
	if user != "1794300000:pid-1" {
		t.Fatalf("username %q", user)
	}
	m := hmac.New(sha1.New, []byte("ci-turn-secret"))
	m.Write([]byte(user))
	if cred != base64.StdEncoding.EncodeToString(m.Sum(nil)) {
		t.Fatal("credential mismatch")
	}
	// Known vector from the TURN REST API draft style: fixed secret and username.
	_, c2 := Sign([]byte("north"), "user", time.Unix(1, 0))
	if c2 == "" || c2 == cred {
		t.Fatal("different inputs must give different credentials")
	}
}

type auth struct{}

func (auth) TurnParticipant(_ context.Context, dev, session string) (string, error) {
	if dev == "joined" {
		return "pid-9", nil
	}
	return "", sharing.ErrNotFound
}

func TestIssueHTTP(t *testing.T) {
	c := clock.NewFake(time.Unix(1794300000, 0))
	iss := New(Config{Secret: []byte("s3cret"), URIs: []string{"turn:t.example:3478"}, Clock: c, Auth: auth{},
		GuestLimit: ratelimit.New(ratelimit.Rule{Limit: 2, Window: time.Hour}, c),
		AcctLimit:  ratelimit.New(ratelimit.Rule{Limit: 5, Window: time.Hour}, c)})
	call := func(dev string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/v1/turn/credentials", strings.NewReader(`{"session_id":"x"}`))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(access.WithIdentity(req.Context(), access.Identity{DeviceID: dev}))
		rec := httptest.NewRecorder()
		iss.issue(rec, req)
		return rec
	}
	rec := call("joined")
	var cr Credentials
	_ = json.Unmarshal(rec.Body.Bytes(), &cr)
	if rec.Code != 200 || cr.TTL != 1800 || cr.Username != strconv.FormatInt(1794300000+1800, 10)+":pid-9" || len(cr.URIs) != 1 {
		t.Fatalf("issue %d %s", rec.Code, rec.Body)
	}
	if _, want := Sign([]byte("s3cret"), "pid-9", time.Unix(1794300000+1800, 0)); cr.Credential != want {
		t.Fatal("credential")
	}
	if rec := call("stranger"); rec.Code != 404 {
		t.Fatalf("not a participant: %d", rec.Code)
	}
	call("joined")
	if rec := call("joined"); rec.Code != 429 {
		t.Fatalf("guest limit: %d", rec.Code)
	}
}
