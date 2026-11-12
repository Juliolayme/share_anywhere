package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

// The abuse soak (docs/phases/PHASE_9_HARDENING_RELEASE.md, docs/SECURITY_MODEL.md §3.2 and §5): an in-process load
// generator drives the whole server (production limits, real PostgreSQL, a fake clock so a simulated hour takes
// seconds) from many client addresses. It asserts that the limits hold, measures how many code guesses get through
// before protected mode trips, and checks that legitimate guests on other addresses keep working during the attack.
// SOAK_SCALE multiplies the number of open sessions under attack (nightly runs a larger soak); SOAK_REPORT writes
// the measurements as JSON.

type soakResult struct {
	Scenario string         `json:"scenario"`
	Values   map[string]any `json:"values"`
}

type soak struct {
	*idorEnv
	clk     *clock.Fake
	rng     *rand.Rand
	nextIP  int
	results []soakResult
}

func (s *soak) addr() string {
	s.nextIP++
	return fmt.Sprintf("10.%d.%d.%d", (s.nextIP>>16)&255, (s.nextIP>>8)&255, s.nextIP&255)
}

func (s *soak) device(name, ip string) (actor, error) {
	d, err := s.a.devices.Create(context.Background(), ip, devices.CreateInput{Platform: "Web", Transport: devices.TransportCookie})
	if err != nil {
		return actor{}, err
	}
	return actor{name: name, ip: ip, token: d.AccessToken, device: d.Device.ID}, nil
}

func (s *soak) record(name string, v map[string]any) {
	s.results = append(s.results, soakResult{Scenario: name, Values: v})
	s.t.Logf("%s: %v", name, v)
}

// openSessions creates n live sessions (one guest sender device per address, two sessions each) and returns their
// codes and link tokens.
func (s *soak) openSessions(n int) (codes map[string]sessionOut, links []string) {
	codes = map[string]sessionOut{}
	for len(codes) < n {
		sender, err := s.device("sender", s.addr())
		if err != nil {
			s.t.Fatal(err)
		}
		for i := 0; i < 2 && len(codes) < n; i++ {
			var out struct {
				sessionOut
				LinkToken string `json:"link_token"`
			}
			s.ok(sender, "POST", "/v1/sessions", map[string]any{"files": []map[string]any{{"name": "a.bin", "size": 1000}}}, &out)
			codes[out.Code] = out.sessionOut
			links = append(links, out.LinkToken)
		}
	}
	return codes, links
}

// guess makes one code lookup from a fresh attacker address and device; a hit is joined at once, as an attacker would.
func (s *soak) guess(codes map[string]sessionOut) (status int, joined bool) {
	ip := s.addr()
	att, err := s.device("attacker", ip)
	if err != nil {
		s.t.Fatal(err)
	}
	// Uniform over the whole code space, blind to which codes are live (as an attacker is); `codes` is only used to
	// count hits afterwards.
	code := fmt.Sprintf("%06d", s.rng.IntN(1_000_000))
	st, raw := s.do(att, "POST", "/v1/sessions/resolve-code", map[string]any{"code": code})
	if st != http.StatusOK {
		return st, false
	}
	var p struct {
		SessionID string `json:"session_id"`
		Ticket    string `json:"join_ticket"`
	}
	_ = json.Unmarshal(raw, &p)
	var j struct {
		Participant struct {
			Status string `json:"status"`
		} `json:"participant"`
	}
	if st, raw := s.do(att, "POST", "/v1/sessions/"+p.SessionID+"/join", map[string]any{"ticket": p.Ticket}); st == http.StatusOK {
		_ = json.Unmarshal(raw, &j)
	}
	return http.StatusOK, j.Participant.Status == "JOINED"
}

func soakScale() int {
	if n, err := strconv.Atoi(os.Getenv("SOAK_SCALE")); err == nil && n > 0 {
		return n
	}
	return 1
}

func TestAbuseSoak(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC))
	a, _ := dbAppWith(t, clk, nil) // production limits: no SA_RATE_LIMIT_MULTIPLIER
	s := &soak{idorEnv: &idorEnv{t: t, a: a}, clk: clk, rng: rand.New(rand.NewPCG(9, 2026))}
	scale := soakScale()

	// 1. Sybil device creation from one address: 3 free, proof of work up to 10, then refused for the hour.
	{
		ip := s.addr()
		free, pow, refused := 0, 0, 0
		for i := 0; i < 20; i++ {
			_, err := s.device("sybil", ip)
			var pe *devices.PoWRequiredError
			var re *devices.RateLimitedError
			switch {
			case err == nil:
				free++
			case errors.As(err, &pe):
				pow++
			case errors.As(err, &re):
				refused++
			default:
				t.Fatal(err)
			}
		}
		if free != 3 || pow != 7 || refused != 10 {
			t.Errorf("sybil: free %d, proof of work %d, refused %d; want 3, 7, 10", free, pow, refused)
		}
		s.record("sybil-one-address", map[string]any{"attempts": 20, "free": free, "pow_required": pow, "refused": refused})
	}

	// 2. CGNAT: 200 people behind one IPv4 address in one hour. New identities are bounded per address (3 free, 10
	// with proof of work); people who already have an identity are bounded by the per-address session, lookup and
	// join limits. Measured, not asserted beyond the documented limits: this is the known cost of per-address keys.
	{
		ip := s.addr()
		var members []actor
		pow, refused := 0, 0
		for i := 0; i < 200; i++ {
			d, err := s.device("cgnat", ip)
			var pe *devices.PoWRequiredError
			var re *devices.RateLimitedError
			switch {
			case err == nil:
				members = append(members, d)
			case errors.As(err, &pe):
				pow++
			case errors.As(err, &re):
				refused++
			default:
				t.Fatal(err) // only the documented refusals count; anything else is a bug in the run
			}
		}
		// Identities created earlier (before the hour) behind the same address: model them with distinct device
		// tokens on the same address, created from elsewhere and then used here.
		var existing []actor
		for i := 0; i < 60; i++ {
			d, err := s.device("cgnat-existing", s.addr())
			if err != nil {
				t.Fatal(err)
			}
			d.ip = ip
			existing = append(existing, d)
		}
		created := 0
		for _, d := range existing {
			if st, _ := s.do(d, "POST", "/v1/sessions", map[string]any{"files": []map[string]any{{"name": "a.bin", "size": 1}}}); st == http.StatusCreated {
				created++
			}
		}
		if len(members) != 3 || created != 30 {
			t.Errorf("cgnat: %d free identities, %d sessions; want 3 and 30 (per-address hour limits)", len(members), created)
		}
		s.record("cgnat-one-address", map[string]any{"people": 200, "identities_free": len(members), "identities_pow": pow,
			"identities_refused": refused, "existing_identities": len(existing), "sessions_created": created})
	}

	// 3. Distributed burst: attackers on fresh addresses guess codes as fast as the service answers until protected
	// mode trips. Every guess comes from its own address and device, so per-address and per-device lockouts never
	// apply: only the global alarm stops it.
	codes, _ := s.openSessions(60 * scale)
	{
		guesses, hits, limited := 0, 0, 0
		start := clk.Now()
		for guesses < 5000 {
			st, joined := s.guess(codes)
			guesses++
			if st == http.StatusTooManyRequests {
				limited++
			}
			if joined {
				hits++
			}
			clk.Advance(50 * time.Millisecond) // 1,200 guesses per simulated minute
			if on, _ := a.protected.Active(); on {
				break
			}
		}
		on, _ := a.protected.Active()
		if !on {
			t.Fatalf("protected mode never tripped after %d guesses", guesses)
		}
		if guesses > 300 {
			t.Errorf("protected mode tripped after %d guesses; the alarm is 300 failed lookups per minute", guesses)
		}
		expected := float64(guesses) * float64(len(codes)) / 1e6
		s.record("distributed-burst", map[string]any{"open_sessions": len(codes), "guesses_before_trip": guesses, "hits": hits,
			"expected_hits": expected, "rate_limited": limited, "seconds_to_trip": clk.Now().Sub(start).Seconds()})

		// In protected mode a correct code no longer admits anyone; a link still does, and legitimate guests on
		// other addresses keep creating identities and sessions.
		var code string
		for c := range codes {
			code = c
			break
		}
		rx, err := s.device("legit-receiver", s.addr())
		if err != nil {
			t.Fatal(err)
		}
		var p struct {
			SessionID string `json:"session_id"`
			Ticket    string `json:"join_ticket"`
			Protected bool   `json:"protected_mode"`
		}
		s.ok(rx, "POST", "/v1/sessions/resolve-code", map[string]any{"code": code}, &p)
		var j struct {
			Participant struct {
				Status string `json:"status"`
			} `json:"participant"`
		}
		s.ok(rx, "POST", "/v1/sessions/"+p.SessionID+"/join", map[string]any{"ticket": p.Ticket}, &j)
		codeJoin := j.Participant.Status
		if !p.Protected || codeJoin != "REQUESTED" {
			t.Errorf("code join in protected mode: preview protected=%v, status %s; want true, REQUESTED", p.Protected, codeJoin)
		}
		ok := 0
		for i := 0; i < 20; i++ {
			sender, err := s.device("legit-sender", s.addr())
			if err != nil {
				t.Fatal(err)
			}
			var out struct {
				ID        string `json:"id"`
				LinkToken string `json:"link_token"`
			}
			s.ok(sender, "POST", "/v1/sessions", map[string]any{"files": []map[string]any{{"name": "a.bin", "size": 1}}}, &out)
			r, err := s.device("legit-link", s.addr())
			if err != nil {
				t.Fatal(err)
			}
			s.ok(r, "POST", "/v1/sessions/resolve-link", map[string]any{"token": out.LinkToken}, &p)
			s.ok(r, "POST", "/v1/sessions/"+out.ID+"/join", map[string]any{"ticket": p.Ticket}, &j)
			if j.Participant.Status == "JOINED" {
				ok++
			}
		}
		if ok != 20 {
			t.Errorf("legitimate link joins during protected mode: %d of 20", ok)
		}
		s.record("legitimate-guests-during-attack", map[string]any{"code_join_status": codeJoin, "link_joins_ok": ok, "of": 20})
	}

	// 4. Slow distributed attack just under the alarm for one whole join window (10 minutes): the model's bound
	// (docs/SECURITY_MODEL.md §3.2) is alarm × 10 guesses per window without tripping protected mode.
	clk.Advance(31 * time.Minute) // protected mode lapses after 30 minutes
	if on, _ := a.protected.Active(); on {
		t.Fatal("protected mode did not lapse")
	}
	codes, _ = s.openSessions(60 * scale)
	{
		perMin := 290
		total := perMin * 10 // one join window at just under the alarm
		guesses, hits := 0, 0
		step := time.Minute / time.Duration(perMin)
		for guesses < total {
			if _, joined := s.guess(codes); joined {
				hits++
			}
			guesses++
			clk.Advance(step)
		}
		on, _ := a.protected.Active()
		if on {
			t.Errorf("protected mode tripped at %d guesses per minute (below the alarm of 300)", perMin)
		}
		expected := float64(guesses) * float64(len(codes)) / 1e6
		s.record("slow-distributed-window", map[string]any{"open_sessions": len(codes), "guesses_per_minute": perMin, "guesses_in_window": guesses,
			"hits": hits, "expected_hits": expected, "per_session_chance": float64(guesses) / 1e6, "protected_mode": on})
	}

	// 5. One address guessing alone is stopped by its own limits long before the alarm.
	{
		ip := s.addr()
		att, err := s.device("lone", ip)
		if err != nil {
			t.Fatal(err)
		}
		failed, limited := 0, 0
		for i := 0; i < 60; i++ {
			att2 := att
			if i%5 == 4 { // a fresh device on the same address every few guesses, as a patient attacker would
				if d, err := s.device("lone", ip); err == nil {
					att2 = d
					att = d
				}
			}
			st, _ := s.do(att2, "POST", "/v1/sessions/resolve-code", map[string]any{"code": fmt.Sprintf("%06d", s.rng.IntN(1_000_000))})
			switch st {
			case http.StatusNotFound, http.StatusGone:
				failed++
			case http.StatusTooManyRequests:
				limited++
			}
			clk.Advance(10 * time.Second)
		}
		if failed > 10 {
			t.Errorf("one address made %d failed lookups in 10 minutes; the per-address limit is 10 per hour", failed)
		}
		s.record("one-address-guessing", map[string]any{"attempts": 60, "failed_lookups": failed, "rate_limited": limited})
	}

	if path := os.Getenv("SOAK_REPORT"); path != "" {
		b, _ := json.MarshalIndent(map[string]any{"alarm_per_min": 300, "scale": scale, "results": s.results}, "", "  ")
		if err := os.WriteFile(path, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
