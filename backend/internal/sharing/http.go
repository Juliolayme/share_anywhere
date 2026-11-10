package sharing

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
)

const maxBody = 256 << 10 // 1,000 file entries fit comfortably

// DeviceLookup returns the display name and platform of an active device.
type DeviceLookup func(ctx context.Context, deviceID string) (name, platform string, err error)

// HTTP exposes the session endpoints (docs/API.md §2.2).
type HTTP struct {
	svc     *Service
	ips     *clientip.Resolver
	devices DeviceLookup
	log     interface {
		Error(msg string, args ...any)
	}
}

// NewHTTP returns the session handlers.
func NewHTTP(svc *Service, ips *clientip.Resolver, devices DeviceLookup) *HTTP {
	return &HTTP{svc: svc, ips: ips, devices: devices, log: svc.cfg.Log}
}

// Register adds the routes with their access levels.
func (h *HTTP) Register(r *access.Router) {
	r.Handle(http.MethodPost, "/v1/sessions", access.Device, h.create)
	r.Handle(http.MethodGet, "/v1/sessions/{id}", access.Participant, h.get)
	r.Handle(http.MethodPatch, "/v1/sessions/{id}", access.Participant, h.update)
	r.Handle(http.MethodPost, "/v1/sessions/{id}/close", access.Participant, h.close)
	r.Handle(http.MethodPost, "/v1/sessions/{id}/renew", access.Participant, h.renew)
	r.Handle(http.MethodPost, "/v1/sessions/resolve-code", access.Device, h.resolveCode)
	r.Handle(http.MethodPost, "/v1/sessions/resolve-link", access.Device, h.resolveLink)
	r.Handle(http.MethodPost, "/v1/sessions/{id}/join", access.Device, h.join)
	r.Handle(http.MethodPost, "/v1/participants/{id}/approve", access.Participant, h.decide("approve"))
	r.Handle(http.MethodPost, "/v1/participants/{id}/reject", access.Participant, h.decide("reject"))
	r.Handle(http.MethodDelete, "/v1/participants/{id}", access.Participant, h.decide("remove"))
	r.Handle(http.MethodPost, "/v1/participants/{id}/block", access.Participant, h.decide("block"))
	r.Handle(http.MethodPost, "/v1/participants/{id}/leave", access.Participant, h.leave)
}

func (h *HTTP) caller(r *http.Request) (Caller, error) {
	id, _ := access.FromContext(r.Context())
	c := Caller{DeviceID: id.DeviceID, SignedIn: id.AccountID != "", IPKey: clientip.Key(h.ips.FromRequest(r))}
	name, platform, err := h.devices(r.Context(), id.DeviceID)
	if err != nil {
		return c, err
	}
	c.DisplayName, c.Platform = name, platform
	return c, nil
}

// WriteError maps service errors to the documented responses.
func WriteError(w http.ResponseWriter, err error, log interface{ Error(string, ...any) }) {
	var e *Error
	switch {
	case errors.As(err, &e) && e.Status == http.StatusTooManyRequests:
		httpx.RateLimited(w, e.Code, e.Wait)
	case errors.As(err, &e):
		httpx.Error(w, e.Status, e.Code, e.Msg)
	default:
		if log != nil {
			log.Error("session request failed", "error", err.Error())
		}
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
	}
}

func (h *HTTP) fail(w http.ResponseWriter, err error) { WriteError(w, err, h.log) }

func (h *HTTP) create(w http.ResponseWriter, r *http.Request) {
	var in CreateInput
	if err := httpx.Decode(r, &in, maxBody, false); err != nil {
		httpx.BadRequest(w, "Expected files and require_approval.")
		return
	}
	c, err := h.caller(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	v, err := h.svc.Create(r.Context(), c, in)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, v)
}

func (h *HTTP) get(w http.ResponseWriter, r *http.Request) {
	id, _ := access.FromContext(r.Context())
	v, err := h.svc.View(r.Context(), id.DeviceID, r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (h *HTTP) update(w http.ResponseWriter, r *http.Request) {
	var in UpdateInput
	if err := httpx.Decode(r, &in, 4<<10, false); err != nil {
		httpx.BadRequest(w, "Expected require_approval or accepting_receivers.")
		return
	}
	c, err := h.caller(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	v, err := h.svc.Update(r.Context(), c, r.PathValue("id"), in)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (h *HTTP) close(w http.ResponseWriter, r *http.Request) {
	c, err := h.caller(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	if err := h.svc.Close(r.Context(), c, r.PathValue("id")); err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": StatusClosed})
}

func (h *HTTP) renew(w http.ResponseWriter, r *http.Request) {
	c, err := h.caller(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	v, err := h.svc.Renew(r.Context(), c, r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (h *HTTP) resolveCode(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
	}
	if err := httpx.Decode(r, &in, 1<<10, false); err != nil {
		httpx.BadRequest(w, "Expected code.")
		return
	}
	c, err := h.caller(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	p, err := h.svc.ResolveCode(r.Context(), c, in.Code)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

func (h *HTTP) resolveLink(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if err := httpx.Decode(r, &in, 1<<10, false); err != nil {
		httpx.BadRequest(w, "Expected token.")
		return
	}
	c, err := h.caller(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	p, err := h.svc.ResolveLink(r.Context(), c, in.Token)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

func (h *HTTP) join(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Ticket string `json:"ticket"`
	}
	if err := httpx.Decode(r, &in, 1<<10, false); err != nil {
		httpx.BadRequest(w, "Expected ticket.")
		return
	}
	c, err := h.caller(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	res, err := h.svc.Join(r.Context(), c, r.PathValue("id"), in.Ticket)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

func (h *HTTP) decide(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var none struct{}
		if err := httpx.Decode(r, &none, 1<<10, true); err != nil {
			httpx.BadRequest(w, "This request takes no body.")
			return
		}
		c, err := h.caller(r)
		if err != nil {
			h.fail(w, err)
			return
		}
		p, err := h.svc.Decide(r.Context(), c, r.PathValue("id"), action)
		if err != nil {
			h.fail(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, p)
	}
}

func (h *HTTP) leave(w http.ResponseWriter, r *http.Request) {
	c, err := h.caller(r)
	if err != nil {
		h.fail(w, err)
		return
	}
	p, err := h.svc.Leave(r.Context(), c, r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

// ServerTime is a helper for handlers outside this package.
func (s *Service) ServerTime() time.Time { return s.now() }
