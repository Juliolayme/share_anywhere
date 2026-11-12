package turncreds

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

// Relay byte caps per session (docs/ARCHITECTURE.md §6, docs/SECURITY_MODEL.md §5): credentials are no longer
// renewed once the session's relay traffic reaches the cap for its sender (guest or signed in).
const (
	DefaultGuestRelayCap   int64 = 25_000_000_000
	DefaultAccountRelayCap int64 = 100_000_000_000
)

// Scoper lists every participant of a session (whatever its status now: relay used before a removal still counts)
// and whether its sender is signed in.
type Scoper interface {
	RelayScope(ctx context.Context, sessionID string) (participantIDs []string, accountSender bool, err error)
}

// Usage reports relay bytes per participant.
type Usage interface {
	RelayBytes(ctx context.Context, participantIDs []string) (int64, error)
}

// CoturnUsage reads coturn's Prometheus exporter (`prometheus` with `prometheus-username-labels`): the peer traffic
// of every allocation, labelled with its username "<expiry>:<participant>". A participant's relay bytes are the sum
// of turn_traffic_peer_sentb and turn_traffic_peer_rcvb over all its usernames; a pair relayed at both ends counts at
// both allocations, so the cap is a coarse abuse guard. Totals are cached for MaxAge.
type CoturnUsage struct {
	URL    string
	Client *http.Client
	Clock  clock.Clock
	MaxAge time.Duration

	mu      sync.Mutex
	at      time.Time
	byParty map[string]int64
}

// RelayBytes sums the cached totals of the given participants.
func (c *CoturnUsage) RelayBytes(ctx context.Context, participantIDs []string) (int64, error) {
	totals, err := c.totals(ctx)
	if err != nil {
		return 0, err
	}
	var sum int64
	for _, id := range participantIDs {
		sum += totals[id]
	}
	return sum, nil
}

func (c *CoturnUsage) totals(ctx context.Context) (map[string]int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.Clock.Now()
	if c.byParty != nil && now.Sub(c.at) < c.MaxAge {
		return c.byParty, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL, nil)
	if err != nil {
		return nil, err
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("coturn metrics: status %d", resp.StatusCode)
	}
	byParty, err := ParseCoturnUsage(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	c.byParty, c.at = byParty, now
	return byParty, nil
}

// ParseCoturnUsage reads coturn's exposition text and returns peer bytes per participant id (the part after the
// first ':' of the username label). Lines it does not need are skipped.
func ParseCoturnUsage(r io.Reader) (map[string]int64, error) {
	out := map[string]int64{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "turn_traffic_peer_sentb{") && !strings.HasPrefix(line, "turn_traffic_peer_rcvb{") {
			continue
		}
		end := strings.LastIndexByte(line, '}')
		if end < 0 {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(line[end+1:]), 64)
		if err != nil || v < 0 {
			continue
		}
		user := label(line[:end], "user")
		_, party, ok := strings.Cut(user, ":")
		if !ok || party == "" {
			continue
		}
		out[party] += int64(v)
	}
	return out, sc.Err()
}

// label returns the value of name="…" inside a label set (coturn does not escape quotes in usernames it issues).
func label(set, name string) string {
	i := strings.Index(set, name+`="`)
	if i < 0 {
		return ""
	}
	rest := set[i+len(name)+2:]
	j := strings.IndexByte(rest, '"')
	if j < 0 {
		return ""
	}
	return rest[:j]
}
