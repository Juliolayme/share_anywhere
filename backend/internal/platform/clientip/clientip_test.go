package clientip

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestFromRequest(t *testing.T) {
	r := New([]netip.Prefix{netip.MustParsePrefix("172.16.0.0/12")})
	cases := map[string]struct {
		remote, xff, want string
	}{
		"untrusted peer ignores XFF":   {"203.0.113.9:1234", "198.51.100.1", "203.0.113.9"},
		"trusted proxy uses XFF":       {"172.18.0.5:443", "198.51.100.1", "198.51.100.1"},
		"rightmost untrusted wins":     {"172.18.0.5:443", "1.1.1.1, 198.51.100.1, 172.18.0.2", "198.51.100.1"},
		"garbage XFF falls back":       {"172.18.0.5:443", "not-an-ip", "172.18.0.5"},
		"no XFF from proxy":            {"172.18.0.5:443", "", "172.18.0.5"},
		"ipv4-mapped ipv6 is unmapped": {"[::ffff:203.0.113.9]:1", "", "203.0.113.9"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = tc.remote
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := r.FromRequest(req).String(); got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
}

func TestKeyAndPrefix(t *testing.T) {
	if Key(netip.MustParseAddr("203.0.113.9")) != "203.0.113.9" {
		t.Fatal("ipv4 key")
	}
	a := netip.MustParseAddr("2001:db8:1:2:3:4:5:6")
	b := netip.MustParseAddr("2001:db8:1:2:ffff::1")
	if Key(a) != Key(b) || Key(a) != "2001:db8:1:2::/64" {
		t.Fatalf("ipv6 /64 key: %s %s", Key(a), Key(b))
	}
	if Prefix(netip.MustParseAddr("203.0.113.9")).String() != "203.0.113.9/32" {
		t.Fatal("ipv4 prefix")
	}
	if Key(netip.Addr{}) != "invalid" {
		t.Fatal("invalid key")
	}
}
