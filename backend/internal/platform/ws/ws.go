// Package ws is the WebSocket hub: one-time tickets, Origin checks, per-device and per-address caps,
// message rate limits, and heartbeats (docs/SECURITY_MODEL.md §4–§5, docs/API.md §4).
package ws

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ratelimit"
)

// Limits and timings (docs/SECURITY_MODEL.md §5).
const (
	TicketTTL        = 30 * time.Second
	MaxPerDevice     = 3
	MaxPerAddress    = 20
	MessagesPerSec   = 50
	HeartbeatEvery   = 25 * time.Second
	maxMessageBytes  = 64 << 10
	writeTimeout     = 10 * time.Second
	ticketsPerMinute = 30
)

// Config configures the hub.
type Config struct {
	AllowedOrigins []string // exact scheme://host[:port] values
	Clock          clock.Clock
	IPs            *clientip.Resolver
	Log            *slog.Logger
}

type ticket struct {
	deviceID string
	expires  time.Time
}

// Hub tracks tickets and live connections.
type Hub struct {
	cfg        Config
	ticketRate *ratelimit.Limiter

	mu        sync.Mutex
	tickets   map[string]ticket
	byDevice  map[string]int
	byAddress map[string]int
}

// NewHub returns a hub.
func NewHub(cfg Config) *Hub {
	return &Hub{
		cfg:        cfg,
		ticketRate: ratelimit.New(ratelimit.Rule{Limit: ticketsPerMinute, Window: time.Minute}, cfg.Clock),
		tickets:    map[string]ticket{},
		byDevice:   map[string]int{},
		byAddress:  map[string]int{},
	}
}

// Register adds the ticket and upgrade routes.
func (h *Hub) Register(r *access.Router) {
	r.Handle(http.MethodPost, "/v1/ws/ticket", access.Device, h.issueTicket)
	r.Handle(http.MethodGet, "/v1/ws", access.Public, h.upgrade)
}

// IssueTicket creates a one-time ticket for a device.
func (h *Hub) IssueTicket(deviceID string) string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	t := base64.RawURLEncoding.EncodeToString(b)
	now := h.cfg.Clock.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, v := range h.tickets {
		if now.After(v.expires) {
			delete(h.tickets, k)
		}
	}
	h.tickets[t] = ticket{deviceID: deviceID, expires: now.Add(TicketTTL)}
	return t
}

// consume returns the device for a valid ticket and deletes it, so it works exactly once.
func (h *Hub) consume(t string) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	v, ok := h.tickets[t]
	delete(h.tickets, t)
	if !ok || h.cfg.Clock.Now().After(v.expires) {
		return "", false
	}
	return v.deviceID, true
}

func (h *Hub) issueTicket(w http.ResponseWriter, r *http.Request) {
	id, _ := access.FromContext(r.Context())
	if ok, wait := h.ticketRate.Allow(id.DeviceID); !ok {
		httpx.RateLimited(w, "rate_limited", wait)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"ticket": h.IssueTicket(id.DeviceID), "expires_in": int(TicketTTL.Seconds())})
}

// originAllowed accepts a missing Origin (native apps do not send one; the ticket still authenticates)
// and otherwise requires an exact match with a configured origin.
func (h *Hub) originAllowed(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	norm := strings.ToLower(u.Scheme + "://" + u.Host)
	for _, o := range h.cfg.AllowedOrigins {
		if strings.EqualFold(o, norm) {
			return true
		}
	}
	return false
}

func (h *Hub) reserve(deviceID, addr string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.byDevice[deviceID] >= MaxPerDevice || h.byAddress[addr] >= MaxPerAddress {
		return false
	}
	h.byDevice[deviceID]++
	h.byAddress[addr]++
	return true
}

func (h *Hub) release(deviceID, addr string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.byDevice[deviceID]--; h.byDevice[deviceID] <= 0 {
		delete(h.byDevice, deviceID)
	}
	if h.byAddress[addr]--; h.byAddress[addr] <= 0 {
		delete(h.byAddress, addr)
	}
}

// Welcome is the first event on every connection (shared/protocol/websocket-events.json).
type Welcome struct {
	Type       string    `json:"type"`
	DeviceID   string    `json:"device_id"`
	ServerTime time.Time `json:"server_time"`
}

func (h *Hub) upgrade(w http.ResponseWriter, r *http.Request) {
	if !h.originAllowed(r.Header.Get("Origin")) {
		httpx.Error(w, http.StatusForbidden, "origin_not_allowed", "This origin may not open a connection.")
		return
	}
	deviceID, ok := h.consume(r.URL.Query().Get("ticket"))
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "ticket_invalid", "The connection ticket is missing, used, or expired.")
		return
	}
	addr := clientip.Key(h.cfg.IPs.FromRequest(r))
	if !h.reserve(deviceID, addr) {
		httpx.RateLimited(w, "too_many_connections", 5*time.Second)
		return
	}
	defer h.release(deviceID, addr)

	// Origin was checked above against the configured list, so the library's same-host check is skipped.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(maxMessageBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	if err := h.write(ctx, c, Welcome{Type: "WELCOME", DeviceID: deviceID, ServerTime: h.cfg.Clock.Now().UTC()}); err != nil {
		return
	}
	go h.heartbeat(ctx, c, cancel)

	limiter := ratelimit.New(ratelimit.Rule{Limit: MessagesPerSec, Window: time.Second}, h.cfg.Clock)
	for {
		if _, _, err := c.Read(ctx); err != nil {
			return
		}
		if ok, _ := limiter.Allow("conn"); !ok {
			_ = c.Close(websocket.StatusPolicyViolation, "message rate exceeded")
			return
		}
		// Phase 1 defines no client-to-server messages; signaling arrives in Phase 2.
	}
}

func (h *Hub) write(ctx context.Context, c *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, b)
}

func (h *Hub) heartbeat(ctx context.Context, c *websocket.Conn, stop context.CancelFunc) {
	t := time.NewTicker(HeartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.Ping(pctx)
			cancel()
			if err != nil {
				stop()
				return
			}
		}
	}
}
