// Package ws is the WebSocket hub: one-time tickets, Origin checks, per-device and per-address caps,
// message rate limits, and heartbeats (docs/SECURITY_MODEL.md §4–§5, docs/API.md §4).
package ws

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"hash/fnv"
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
	"github.com/juliolayme/share_anywhere/backend/internal/platform/metrics"
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
	// Presence hooks run off the handshake on presenceShards workers (a device always maps to the same one),
	// each with a queue of presenceQueue events. Events are queued under the hub lock at the moment the
	// device's socket count changes, so one device's CONNECTED and DISCONNECTED reach the hooks in the order
	// the changes happened, across sockets. An event that finds its queue full is dropped, logged and counted
	// (sa_ws_presence_dropped_total) rather than holding up a socket.
	presenceShards = 4
	presenceQueue  = 256
)

// Config configures the hub.
type Config struct {
	AllowedOrigins []string // exact scheme://host[:port] values
	Clock          clock.Clock
	IPs            *clientip.Resolver
	Log            *slog.Logger
	Metrics        *metrics.Registry // optional: sa_ws_presence_dropped_total
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
	conns     map[string]map[*conn]struct{}
	handlers  map[string]Handler
	presence  []func(deviceID string, connected bool)
	presenceQ []chan presenceEvent // started by the first OnPresence
	// presenceCap is the queue size per worker (presenceQueue; tests change it before OnPresence).
	presenceCap  int
	presenceStop chan struct{} // closed by Close
	presenceWG   sync.WaitGroup
	closed       bool
	dropped      *metrics.Counter
}

type presenceEvent struct {
	deviceID  string
	connected bool
}

// Handler processes one client message of a registered type for the authenticated device. A returned
// *Error is sent back to that socket as an ERROR event; other errors close nothing and are logged.
type Handler func(ctx context.Context, deviceID string, raw json.RawMessage) error

// Error is a client-visible error reply to a message (`ERROR` event).
type Error struct {
	Code string `json:"code"`
}

func (e *Error) Error() string { return e.Code }

// conn is one live socket with its own writer goroutine, so writes never race.
type conn struct {
	deviceID string
	out      chan []byte
	cancel   context.CancelFunc
}

const sendQueue = 64

// NewHub returns a hub.
func NewHub(cfg Config) *Hub {
	dropped := new(metrics.Counter)
	if cfg.Metrics != nil {
		dropped = cfg.Metrics.Counter("sa_ws_presence_dropped_total",
			"Device presence events dropped because a presence worker queue was full.")
	}
	return &Hub{
		cfg:         cfg,
		presenceCap: presenceQueue,
		dropped:     dropped,
		ticketRate:  ratelimit.New(ratelimit.Rule{Limit: ticketsPerMinute, Window: time.Minute}, cfg.Clock),
		tickets:     map[string]ticket{},
		byDevice:    map[string]int{},
		byAddress:   map[string]int{},
		conns:       map[string]map[*conn]struct{}{},
		handlers:    map[string]Handler{},
	}
}

// PresenceDropped returns how many presence events were dropped because a worker queue was full.
func (h *Hub) PresenceDropped() int64 { return h.dropped.Value() }

// Handle registers the handler for client messages of type t (e.g. OFFER, ANSWER, ICE_CANDIDATE).
func (h *Hub) Handle(t string, fn Handler) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.handlers[t] = fn
}

// OnPresence registers fn to run when a device opens its first socket (connected true) or closes its last one
// (connected false). It runs asynchronously on a hub worker, outside the hub lock and never on the handshake
// (WELCOME does not wait for it); one device's events reach fn in the order its socket count changed, across
// sockets. fn must bound its own work (the workers are shared). Register before serving; Close stops the
// workers.
func (h *Hub) OnPresence(fn func(deviceID string, connected bool)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.presence = append(h.presence, fn)
	if h.presenceQ == nil && !h.closed {
		h.presenceStop = make(chan struct{})
		h.presenceQ = make([]chan presenceEvent, presenceShards)
		for i := range h.presenceQ {
			q := make(chan presenceEvent, h.presenceCap)
			h.presenceQ[i] = q
			h.presenceWG.Add(1)
			go h.presenceWorker(q, h.presenceStop)
		}
	}
}

// Close stops the presence workers (server shutdown, tests) and waits for them: a hook running now finishes
// first (hooks bound their own work), queued events not yet delivered are discarded, and later socket changes
// announce nothing. Sockets are not closed. Safe to call more than once.
func (h *Hub) Close() {
	h.mu.Lock()
	if !h.closed {
		h.closed = true
		if h.presenceStop != nil {
			close(h.presenceStop)
		}
	}
	h.mu.Unlock()
	h.presenceWG.Wait()
}

func (h *Hub) presenceWorker(q <-chan presenceEvent, stop <-chan struct{}) {
	defer h.presenceWG.Done()
	for {
		select {
		case <-stop:
			return
		case ev := <-q:
			select {
			case <-stop: // stopping wins over a queued event
				return
			default:
			}
			h.mu.Lock()
			fns := append([]func(string, bool){}, h.presence...)
			h.mu.Unlock()
			for _, fn := range fns {
				fn(ev.deviceID, ev.connected)
			}
		}
	}
}

// add tracks a socket; when it is the device's first open one, DEVICE presence (connected) is queued in the
// same critical section, so it is ordered with the device's other presence changes.
func (h *Hub) add(c *conn) {
	h.mu.Lock()
	if h.conns[c.deviceID] == nil {
		h.conns[c.deviceID] = map[*conn]struct{}{}
	}
	h.conns[c.deviceID][c] = struct{}{}
	dropped := len(h.conns[c.deviceID]) == 1 && !h.queuePresenceLocked(c.deviceID, true)
	h.mu.Unlock()
	if dropped {
		h.logDropped(true)
	}
}

// remove forgets a socket; when it was the device's last open one, presence (disconnected) is queued in the
// same critical section.
func (h *Hub) remove(c *conn) {
	h.mu.Lock()
	delete(h.conns[c.deviceID], c)
	dropped := false
	if len(h.conns[c.deviceID]) == 0 {
		delete(h.conns, c.deviceID)
		dropped = !h.queuePresenceLocked(c.deviceID, false)
	}
	h.mu.Unlock()
	if dropped {
		h.logDropped(false)
	}
}

// queuePresenceLocked queues a presence event for the hooks without blocking (the caller holds h.mu). It
// reports false when the event was dropped because the device's worker queue is full; no hooks or a closed
// hub queue nothing and report true.
func (h *Hub) queuePresenceLocked(deviceID string, connected bool) bool {
	if len(h.presenceQ) == 0 || h.closed {
		return true
	}
	f := fnv.New32a()
	_, _ = f.Write([]byte(deviceID))
	select {
	case h.presenceQ[f.Sum32()%presenceShards] <- presenceEvent{deviceID: deviceID, connected: connected}:
		return true
	default:
		h.dropped.Inc()
		return false
	}
}

func (h *Hub) logDropped(connected bool) {
	if h.cfg.Log != nil {
		h.cfg.Log.Warn("websocket presence queue full; event dropped", "connected", connected, "dropped_total", h.dropped.Value())
	}
}

// enqueue queues a frame; a socket that cannot keep up is closed rather than blocking the sender.
func (c *conn) enqueue(b []byte) {
	select {
	case c.out <- b:
	default:
		c.cancel()
	}
}

// SendToDevice delivers an event to every open socket of a device. It reports whether any socket was open.
func (h *Hub) SendToDevice(deviceID string, v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns[deviceID] {
		c.enqueue(b)
	}
	return len(h.conns[deviceID]) > 0
}

// Broadcast delivers an event to every open socket.
func (h *Hub) Broadcast(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, set := range h.conns {
		for c := range set {
			c.enqueue(b)
		}
	}
}

// Connected reports whether the device has at least one open socket.
func (h *Hub) Connected(deviceID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns[deviceID]) > 0
}

// DisconnectDevice closes every socket of a device, e.g. when its identity is revoked or reset.
func (h *Hub) DisconnectDevice(deviceID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns[deviceID] {
		c.cancel()
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
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = ws.CloseNow() }()
	ws.SetReadLimit(maxMessageBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &conn{deviceID: deviceID, out: make(chan []byte, sendQueue), cancel: cancel}
	// Presence (a database lookup in the clipboard hook) is queued by add and remove and runs on a hub worker,
	// so the handshake never waits for it; other devices hear of this arrival shortly after.
	h.add(c)
	defer h.remove(c)
	go h.writer(ctx, ws, c)
	welcome, _ := json.Marshal(Welcome{Type: "WELCOME", DeviceID: deviceID, ServerTime: h.cfg.Clock.Now().UTC()})
	c.enqueue(welcome)
	go h.heartbeat(ctx, ws, cancel)

	limiter := ratelimit.New(ratelimit.Rule{Limit: MessagesPerSec, Window: time.Second}, h.cfg.Clock)
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if ok, _ := limiter.Allow("conn"); !ok {
			_ = ws.Close(websocket.StatusPolicyViolation, "message rate exceeded")
			return
		}
		h.dispatch(ctx, c, data)
	}
}

type envelope struct {
	Type string `json:"type"`
	Ref  string `json:"ref,omitempty"`
}

// dispatch routes a client message to its handler; unknown types and handler errors get an ERROR reply.
func (h *Hub) dispatch(ctx context.Context, c *conn, data []byte) {
	var env envelope
	if json.Unmarshal(data, &env) != nil || env.Type == "" {
		h.reply(c, "", "bad_message")
		return
	}
	h.mu.Lock()
	fn := h.handlers[env.Type]
	h.mu.Unlock()
	if fn == nil {
		h.reply(c, env.Ref, "unknown_type")
		return
	}
	if err := fn(ctx, c.deviceID, data); err != nil {
		var e *Error
		if errors.As(err, &e) {
			h.reply(c, env.Ref, e.Code)
			return
		}
		h.cfg.Log.Error("websocket handler failed", "type", env.Type, "error", err.Error())
		h.reply(c, env.Ref, "internal")
	}
}

func (h *Hub) reply(c *conn, ref, code string) {
	b, _ := json.Marshal(map[string]string{"type": "ERROR", "code": code, "ref": ref})
	c.enqueue(b)
}

func (h *Hub) writer(ctx context.Context, ws *websocket.Conn, c *conn) {
	for {
		select {
		case <-ctx.Done():
			_ = ws.Close(websocket.StatusNormalClosure, "")
			return
		case b := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := ws.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
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
