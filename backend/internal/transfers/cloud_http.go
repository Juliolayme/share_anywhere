package transfers

import (
	"io"
	"net/http"
	"strconv"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
)

// registerCloud adds the Cloud Distribution routes (docs/API.md §2.6). Distribute and the upload routes are device
// level so a guest gets 403 cloud_requires_account (docs/PRODUCT_REQUIREMENTS.md §6.6) rather than the generic
// account_required; the handlers require the acct claim and object ownership.
func (h *HTTP) registerCloud(r *access.Router) {
	r.Handle(http.MethodGet, "/v1/cloud/settings", access.Device, h.cloudSettings)
	r.Handle(http.MethodPut, "/v1/cloud/settings", access.Account, h.putCloudSettings)
	r.Handle(http.MethodPost, "/v1/cloud/estimate", access.Account, h.estimate)
	r.Handle(http.MethodPost, "/v1/files/{id}/distribute", access.Device, h.distribute)
	r.Handle(http.MethodPut, "/v1/cloud/objects/{id}/parts/{n}", access.Device, h.putPart)
	r.Handle(http.MethodPost, "/v1/cloud/objects/{id}/seal", access.Device, h.seal)
	r.Handle(http.MethodGet, "/v1/sessions/{id}/cloud", access.Participant, h.sessionObjects)
	r.Handle(http.MethodGet, "/v1/cloud/objects/{id}", access.Participant, h.object)
	r.Handle(http.MethodGet, "/v1/cloud/objects/{id}/parts/{n}", access.Participant, h.getPart)
	r.Handle(http.MethodPost, "/v1/cloud/objects/{id}/received", access.Participant, h.received)
}

func identity(r *http.Request) access.Identity {
	id, _ := access.FromContext(r.Context())
	return id
}

func partNumber(r *http.Request) (int, bool) {
	n, err := strconv.Atoi(r.PathValue("n"))
	return n, err == nil && n >= 0
}

func (h *HTTP) cloudSettings(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.CloudSettings(r.Context(), identity(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *HTTP) putCloudSettings(w http.ResponseWriter, r *http.Request) {
	var in CloudSettingsInput
	if err := httpx.Decode(r, &in, 1<<10, false); err != nil {
		httpx.BadRequest(w, "Send enabled, consent and optionally budget_bytes.")
		return
	}
	out, err := h.svc.PutCloudSettings(r.Context(), identity(r), in)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *HTTP) estimate(w http.ResponseWriter, r *http.Request) {
	var in EstimateInput
	if err := httpx.Decode(r, &in, 1<<10, false); err != nil {
		httpx.BadRequest(w, "Send bytes and receivers.")
		return
	}
	out, err := h.svc.EstimateCloud(r.Context(), identity(r), in)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *HTTP) distribute(w http.ResponseWriter, r *http.Request) {
	if err := httpx.Decode(r, &struct{}{}, 1<<10, true); err != nil {
		httpx.BadRequest(w, "The body must be empty or {}.")
		return
	}
	o, created, err := h.svc.Distribute(r.Context(), identity(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, o)
}

func (h *HTTP) putPart(w http.ResponseWriter, r *http.Request) {
	n, ok := partNumber(r)
	if !ok {
		h.fail(w, errCloudPart)
		return
	}
	limit := int64(DefaultCloudPartSize + PartOverhead)
	if c := h.svc.cfg.Cloud; c != nil {
		limit = int64(c.PartSize + PartOverhead)
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		h.fail(w, errCloudPart)
		return
	}
	o, err := h.svc.PutPart(r.Context(), identity(r), r.PathValue("id"), n, body)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, o)
}

func (h *HTTP) seal(w http.ResponseWriter, r *http.Request) {
	o, err := h.svc.Seal(r.Context(), identity(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, o)
}

func (h *HTTP) sessionObjects(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.SessionObjects(r.Context(), device(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"objects": out})
}

func (h *HTTP) object(w http.ResponseWriter, r *http.Request) {
	o, err := h.svc.Object(r.Context(), device(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, o)
}

func (h *HTTP) getPart(w http.ResponseWriter, r *http.Request) {
	n, ok := partNumber(r)
	if !ok {
		h.fail(w, errCloudPart)
		return
	}
	b, err := h.svc.GetPart(r.Context(), device(r), r.PathValue("id"), n)
	if err != nil {
		h.fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b) // #nosec G705 -- opaque client ciphertext served as application/octet-stream with nosniff, never rendered

}

func (h *HTTP) received(w http.ResponseWriter, r *http.Request) {
	o, err := h.svc.Received(r.Context(), device(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, o)
}
