package transfers

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// HTTP exposes the transfer endpoints (docs/API.md §2.3).
type HTTP struct {
	svc *Service
	log *slog.Logger
}

// NewHTTP returns the handlers.
func NewHTTP(svc *Service, log *slog.Logger) *HTTP { return &HTTP{svc: svc, log: log} }

// Register adds the routes with their access levels.
func (h *HTTP) Register(r *access.Router) {
	r.Handle(http.MethodGet, "/v1/sessions/{id}/files", access.Participant, h.files)
	r.Handle(http.MethodGet, "/v1/sessions/{id}/transfers", access.Participant, h.list)
	r.Handle(http.MethodGet, "/v1/transfers/{id}", access.Participant, h.get)
	r.Handle(http.MethodPost, "/v1/transfers/{id}/report", access.Participant, h.report)
	r.Handle(http.MethodPost, "/v1/transfers/{id}/pause", access.Participant, h.action("pause"))
	r.Handle(http.MethodPost, "/v1/transfers/{id}/resume", access.Participant, h.action("resume"))
	r.Handle(http.MethodPost, "/v1/transfers/{id}/cancel", access.Participant, h.action("cancel"))
}

func device(r *http.Request) string {
	id, _ := access.FromContext(r.Context())
	return id.DeviceID
}

func (h *HTTP) fail(w http.ResponseWriter, err error) {
	var e *Error
	var se *sharing.Error
	switch {
	case errors.As(err, &e) && e.Status == http.StatusTooManyRequests:
		httpx.RateLimited(w, e.Code, e.Wait)
	case errors.As(err, &e):
		httpx.Error(w, e.Status, e.Code, e.Msg)
	case errors.As(err, &se):
		sharing.WriteError(w, err, h.log)
	default:
		h.log.Error("transfer request failed", "error", err.Error())
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
	}
}

func (h *HTTP) files(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Files(r.Context(), device(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"files": out})
}

func (h *HTTP) list(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.List(r.Context(), device(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *HTTP) get(w http.ResponseWriter, r *http.Request) {
	t, err := h.svc.Get(r.Context(), device(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, t)
}

func (h *HTTP) report(w http.ResponseWriter, r *http.Request) {
	var body Report
	if err := httpx.Decode(r, &body, 4<<10, false); err != nil {
		httpx.BadRequest(w, "Send status, verified_bytes and optionally route.")
		return
	}
	t, err := h.svc.Report(r.Context(), device(r), r.PathValue("id"), body)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, t)
}

func (h *HTTP) action(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Capability string `json:"capability"`
		}
		if err := httpx.Decode(r, &body, 1<<10, true); err != nil {
			httpx.BadRequest(w, "The body may only carry the transfer capability.")
			return
		}
		t, err := h.svc.Action(r.Context(), device(r), r.PathValue("id"), name, body.Capability)
		if err != nil {
			h.fail(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, t)
	}
}
