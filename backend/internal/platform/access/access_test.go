package access

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeVerifier map[string]Identity

func (f fakeVerifier) Verify(_ context.Context, token string) (Identity, error) {
	switch token {
	case "expired":
		return Identity{}, ErrTokenExpired
	}
	id, ok := f[token]
	if !ok {
		return Identity{}, ErrTokenInvalid
	}
	return id, nil
}

func setup() *http.ServeMux {
	mux := http.NewServeMux()
	r := NewRouter(mux, fakeVerifier{
		"guest":    {DeviceID: "d1"},
		"notadded": {DeviceID: "d2", AccountID: "u1"},
		"added":    {DeviceID: "d3", AccountID: "u1", DeviceAdded: true},
	})
	ok := func(w http.ResponseWriter, req *http.Request) {
		id, _ := FromContext(req.Context())
		_, _ = w.Write([]byte("ok:" + id.DeviceID))
	}
	r.Handle("GET", "/pub", Public, ok)
	r.Handle("GET", "/dev", Device, ok)
	r.Handle("GET", "/acct", Account, ok)
	r.Handle("GET", "/keys", AccountDevice, ok)
	return mux
}

func call(mux *http.ServeMux, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestLevels(t *testing.T) {
	mux := setup()
	cases := []struct {
		path, token string
		code        int
		body        string
	}{
		{"/pub", "", 200, "ok:"},
		{"/dev", "", 401, "device_token_invalid"},
		{"/dev", "garbage", 401, "device_token_invalid"},
		{"/dev", "expired", 401, "device_token_expired"},
		{"/dev", "guest", 200, "ok:d1"},
		{"/acct", "guest", 403, "account_required"},
		{"/acct", "notadded", 200, "ok:d2"},
		{"/keys", "guest", 403, "account_required"},
		{"/keys", "notadded", 403, "device_not_added"},
		{"/keys", "added", 200, "ok:d3"},
	}
	for _, c := range cases {
		rec := call(mux, "GET", c.path, c.token)
		if rec.Code != c.code || !strings.Contains(rec.Body.String(), c.body) {
			t.Errorf("%s with %q: got %d %s, want %d %s", c.path, c.token, rec.Code, rec.Body.String(), c.code, c.body)
		}
	}
}

func TestMethodNotAllowedListsMethods(t *testing.T) {
	rec := call(setup(), "POST", "/dev", "guest")
	if rec.Code != 405 || rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("got %d %v", rec.Code, rec.Header())
	}
}

func TestBearerParsing(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "bearer   tok ")
	if tok, ok := bearer(req); !ok || tok != "tok" {
		t.Fatalf("got %q %v", tok, ok)
	}
	req.Header.Set("Authorization", "Basic xyz")
	if _, ok := bearer(req); ok {
		t.Fatal("basic auth must not be accepted")
	}
}
