package clipboard

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/juliolayme/share_anywhere/backend/internal/auth"
	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
)

const (
	// maxEventBody fits a MaxCiphertext ciphertext in base64url (349,547 characters) plus the other fields; a
	// larger body is 413 payload_too_large.
	maxEventBody    = 384 << 10
	maxSettingsBody = 1 << 10
)

// HTTP exposes the clipboard endpoints (docs/API.md §2.5).
type HTTP struct{ svc *Service }

// NewHTTP returns the clipboard handlers.
func NewHTTP(svc *Service) *HTTP { return &HTTP{svc: svc} }

// Register adds the routes with their access levels (shared/protocol/openapi.yaml x-sa-access).
func (h *HTTP) Register(r *access.Router) {
	r.Handle(http.MethodPost, "/v1/clipboard/events", access.AccountDevice, h.create)
	r.Handle(http.MethodGet, "/v1/clipboard/events", access.AccountDevice, h.events)
	r.Handle(http.MethodDelete, "/v1/clipboard/events/{event_id}", access.AccountDevice, h.delete)
	r.Handle(http.MethodGet, "/v1/clipboard/history", access.AccountDevice, h.history)
	r.Handle(http.MethodDelete, "/v1/clipboard/history", access.AccountDevice, h.clear)
	r.Handle(http.MethodGet, "/v1/clipboard/settings", access.AccountDevice, h.getSettings)
	r.Handle(http.MethodPut, "/v1/clipboard/settings", access.AccountDevice, h.putSettings)
}

func ident(r *http.Request) access.Identity {
	id, _ := access.FromContext(r.Context())
	return id
}

func (h *HTTP) fail(w http.ResponseWriter, err error) {
	var e *auth.Error
	switch {
	case errors.As(err, &e) && e.Status == http.StatusTooManyRequests:
		httpx.RateLimited(w, e.Code, e.Wait)
	case errors.As(err, &e):
		httpx.Error(w, e.Status, e.Code, e.Msg)
	case errors.Is(err, devices.ErrNotFound), errors.Is(err, devices.ErrDeviceInactive):
		httpx.Error(w, http.StatusUnauthorized, "device_token_invalid", "This device is no longer active.")
	default:
		h.svc.cfg.Log.Error("clipboard request failed", "error", err.Error())
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
	}
}

func (h *HTTP) create(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxEventBody))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		h.fail(w, ErrTooLarge)
		return
	}
	if err != nil {
		httpx.BadRequest(w, "Could not read the request body.")
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var b EventInput
	if err := httpx.Decode(r, &b, maxEventBody, false); err != nil {
		httpx.BadRequest(w, "Expected event_id, key_version, nonce, ciphertext, and payload_size.")
		return
	}
	out, err := h.svc.Create(r.Context(), ident(r), b)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, out)
}

func intParam(r *http.Request, name string, def, lo, hi int64) (int64, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def, true
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < lo || n > hi {
		return 0, false
	}
	return n, true
}

func (h *HTTP) events(w http.ResponseWriter, r *http.Request) {
	cursor, ok := intParam(r, "cursor", 0, 0, 1<<62)
	if !ok {
		httpx.BadRequest(w, "cursor must be a non-negative integer.")
		return
	}
	limit, ok := intParam(r, "limit", defaultLimit, 1, maxPageLimit)
	if !ok {
		httpx.BadRequest(w, "limit must be between 1 and 200.")
		return
	}
	p, err := h.svc.Events(r.Context(), ident(r), cursor, int(limit))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

func (h *HTTP) history(w http.ResponseWriter, r *http.Request) {
	limit, ok := intParam(r, "limit", defaultLimit, 1, maxHistLimit)
	if !ok {
		httpx.BadRequest(w, "limit must be between 1 and 100.")
		return
	}
	p, err := h.svc.History(r.Context(), ident(r), int(limit))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

func (h *HTTP) delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), ident(r), r.PathValue("event_id")); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) clear(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Clear(r.Context(), ident(r)); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) getSettings(w http.ResponseWriter, r *http.Request) {
	st, err := h.svc.GetSettings(r.Context(), ident(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

func (h *HTTP) putSettings(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Paused        *bool `json:"paused"`
		RetentionDays *int  `json:"retention_days"`
		SensitiveSkip *bool `json:"sensitive_skip"`
	}
	if err := httpx.Decode(r, &b, maxSettingsBody, false); err != nil || b.Paused == nil || b.RetentionDays == nil || b.SensitiveSkip == nil {
		httpx.BadRequest(w, "Expected paused, retention_days (1 to 7), and sensitive_skip.")
		return
	}
	st, err := h.svc.PutSettings(r.Context(), ident(r), Settings{Paused: *b.Paused, RetentionDays: *b.RetentionDays, SensitiveSkip: *b.SensitiveSkip})
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}
