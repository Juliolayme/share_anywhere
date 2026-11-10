// Package clientip determines the client address behind trusted proxies and derives rate-limit keys.
package clientip

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Resolver trusts X-Forwarded-For only when the direct peer is a trusted proxy (docs/SECURITY_MODEL.md §5).
type Resolver struct {
	trusted []netip.Prefix
}

// New returns a resolver trusting the given proxy prefixes.
func New(trusted []netip.Prefix) *Resolver { return &Resolver{trusted: trusted} }

func (r *Resolver) isTrusted(a netip.Addr) bool {
	for _, p := range r.trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// FromRequest returns the client address. X-Forwarded-For is walked from the right, skipping trusted
// proxies, and only when the request itself came from a trusted proxy.
func (r *Resolver) FromRequest(req *http.Request) netip.Addr {
	peer := parseHostPort(req.RemoteAddr)
	if !peer.IsValid() || !r.isTrusted(peer) {
		return peer
	}
	hops := strings.Split(strings.Join(req.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			return peer
		}
		a = a.Unmap()
		if !r.isTrusted(a) {
			return a
		}
	}
	return peer
}

func parseHostPort(s string) netip.Addr {
	host, _, err := net.SplitHostPort(s)
	if err != nil {
		host = s
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

// Key returns the rate-limit key for an address: the full IPv4 address, or the /64 prefix for IPv6.
func Key(a netip.Addr) string {
	if !a.IsValid() {
		return "invalid"
	}
	if a.Is4() {
		return a.String()
	}
	p, _ := a.Prefix(64)
	return p.String()
}

// Prefix returns the block prefix stored for session blocks: /32 for IPv4, /64 for IPv6.
func Prefix(a netip.Addr) netip.Prefix {
	bits := 64
	if a.Is4() {
		bits = 32
	}
	p, _ := a.Prefix(bits)
	return p
}
