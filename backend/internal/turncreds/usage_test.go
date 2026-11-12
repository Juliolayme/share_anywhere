package turncreds

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
)

// Excerpt of coturn 4.6 output with prometheus-username-labels (captured from the CI coturn).
const coturnSample = `# HELP turn_traffic_peer_sentb Represents finished sessions peer sent bytes
# TYPE turn_traffic_peer_sentb counter
turn_traffic_sentb{realm="shareanywhere.local",user="1794491716:pid-a"} 30442143
turn_traffic_peer_sentb{realm="shareanywhere.local",user="1794491716:pid-a"} 1000
turn_traffic_peer_rcvb{realm="shareanywhere.local",user="1794491716:pid-a"} 2000
turn_traffic_peer_sentb{realm="shareanywhere.local",user="1794493516:pid-a"} 500
turn_traffic_peer_rcvb{realm="shareanywhere.local",user="1794491800:pid-b"} 4e+03
turn_traffic_peer_rcvb{realm="shareanywhere.local",user="no-colon"} 99
turn_traffic_peer_rcvb{realm="shareanywhere.local",user="1794491800:pid-c"} not-a-number
turn_total_allocations{type="UDP"} 3
`

func TestParseCoturnUsageSumsPeerBytesPerParticipant(t *testing.T) {
	got, err := ParseCoturnUsage(strings.NewReader(coturnSample))
	if err != nil {
		t.Fatal(err)
	}
	if got["pid-a"] != 3500 || got["pid-b"] != 4000 || len(got) != 2 {
		t.Fatalf("totals %v", got)
	}
}

func TestCoturnUsageCachesForMaxAge(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(coturnSample))
	}))
	defer srv.Close()
	c := clock.NewFake(time.Unix(1794300000, 0))
	u := &CoturnUsage{URL: srv.URL, Clock: c, MaxAge: 10 * time.Second}
	n, err := u.RelayBytes(context.Background(), []string{"pid-a", "pid-b", "pid-x"})
	if err != nil || n != 7500 {
		t.Fatalf("bytes %d %v", n, err)
	}
	_, _ = u.RelayBytes(context.Background(), []string{"pid-a"})
	if hits.Load() != 1 {
		t.Fatalf("cached read hit the exporter %d times", hits.Load())
	}
	c.Advance(11 * time.Second)
	_, _ = u.RelayBytes(context.Background(), []string{"pid-a"})
	if hits.Load() != 2 {
		t.Fatalf("stale cache not refreshed: %d", hits.Load())
	}
}

func TestCoturnUsageReportsExporterErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	u := &CoturnUsage{URL: srv.URL, Clock: clock.NewFake(time.Now()), MaxAge: time.Second}
	if _, err := u.RelayBytes(context.Background(), []string{"pid-a"}); err == nil {
		t.Fatal("a failing exporter must surface an error")
	}
}

type scope struct{ account bool }

func (s scope) RelayScope(context.Context, string) ([]string, bool, error) {
	return []string{"pid-9", "pid-r"}, s.account, nil
}

type usage struct {
	bytes int64
	err   error
}

func (u usage) RelayBytes(context.Context, []string) (int64, error) { return u.bytes, u.err }

type count struct{ n int }

func (c *count) Inc() { c.n++ }

func TestRelayCapStopsRenewal(t *testing.T) {
	c := clock.NewFake(time.Unix(1794300000, 0))
	issue := func(sc Scoper, us Usage, refused, unavailable *count) *httptest.ResponseRecorder {
		iss := New(Config{Secret: []byte("s3cret"), URIs: []string{"turn:t.example:3478"}, Clock: c, Auth: auth{},
			GuestLimit: ratelimit.New(ratelimit.Rule{Limit: 100, Window: time.Hour}, c),
			AcctLimit:  ratelimit.New(ratelimit.Rule{Limit: 100, Window: time.Hour}, c),
			Scope:      sc, Usage: us, GuestCap: 1000, AccountCap: 5000, CapRefused: refused, UsageUnavailable: unavailable})
		req := httptest.NewRequest("POST", "/v1/turn/credentials", strings.NewReader(`{"session_id":"x"}`))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(access.WithIdentity(req.Context(), access.Identity{DeviceID: "joined"}))
		rec := httptest.NewRecorder()
		iss.issue(rec, req)
		return rec
	}
	refused, unavailable := &count{}, &count{}
	if rec := issue(scope{}, usage{bytes: 999}, refused, unavailable); rec.Code != 200 {
		t.Fatalf("under the guest cap: %d", rec.Code)
	}
	rec := issue(scope{}, usage{bytes: 1000}, refused, unavailable)
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 403 || body.Error != "relay_cap_reached" || refused.n != 1 {
		t.Fatalf("at the guest cap: %d %s", rec.Code, rec.Body)
	}
	if rec := issue(scope{account: true}, usage{bytes: 1000}, refused, unavailable); rec.Code != 200 {
		t.Fatalf("a signed-in sender has the larger cap: %d", rec.Code)
	}
	if rec := issue(scope{account: true}, usage{bytes: 5000}, refused, unavailable); rec.Code != 403 {
		t.Fatalf("at the account cap: %d", rec.Code)
	}
	if rec := issue(scope{}, usage{err: errors.New("down")}, refused, unavailable); rec.Code != 200 || unavailable.n != 1 {
		t.Fatalf("unreadable usage fails open and is counted: %d %d", rec.Code, unavailable.n)
	}
}
