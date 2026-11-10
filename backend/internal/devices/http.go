package devices

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/api"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
)

// Refresh cookie (docs/SECURITY_MODEL.md §4): HttpOnly, SameSite=Strict, scoped to the refresh path.
const (
	CookieName    = "sa_device"
	cookiePath    = "/v1/devices/token"
	refreshHeader = "X-SA-Refresh"
	maxBody       = 4 << 10
)

// HTTP exposes the device endpoints.
type HTTP struct {
	svc          *Service
	ips          *clientip.Resolver
	clock        clock.Clock
	cookieSecure bool
}

// NewHTTP returns the device HTTP handlers.
func NewHTTP(svc *Service, ips *clientip.Resolver, c clock.Clock, cookieSecure bool) *HTTP {
	return &HTTP{svc: svc, ips: ips, clock: c, cookieSecure: cookieSecure}
}

// Register adds the device routes with their access levels (docs/API.md §2.1).
func (h *HTTP) Register(r *access.Router) {
	r.Handle(http.MethodGet, "/v1/devices/anonymous/challenge", access.Public, h.challenge)
	r.Handle(http.MethodPost, "/v1/devices/anonymous", access.Public, h.create)
	r.Handle(http.MethodPost, "/v1/devices/token", access.Public, h.refresh)
	r.Handle(http.MethodGet, "/v1/devices/current", access.Device, h.current)
	r.Handle(http.MethodPatch, "/v1/devices/current", access.Device, h.rename)
	r.Handle(http.MethodPost, "/v1/devices/current/reset", access.Device, h.reset)
}

func (h *HTTP) addrKey(r *http.Request) string { return clientip.Key(h.ips.FromRequest(r)) }

func toAPIDevice(d Device) api.Device {
	id, _ := uuid.Parse(d.ID)
	return api.Device{
		Id: id, Kind: api.DeviceKind(d.Kind), DisplayName: d.DisplayName, Platform: d.Platform,
		CreatedAt: d.CreatedAt.UTC(), LastSeenAt: d.LastSeenAt.UTC(),
	}
}

func (h *HTTP) writeSession(w http.ResponseWriter, status int, s Session, cookie bool) {
	body := api.DeviceSession{
		Device: toAPIDevice(s.Device), AccessToken: s.AccessToken, ExpiresIn: s.ExpiresIn, ServerTime: h.clock.Now().UTC(),
	}
	if cookie {
		// Secure is false only when SA_COOKIE_SECURE=false, which config rejects in production.
		http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly and SameSite=Strict always; Secure from validated config
			Name: CookieName, Value: s.Secret, Path: cookiePath, HttpOnly: true, Secure: h.cookieSecure,
			SameSite: http.SameSiteStrictMode, MaxAge: int(AnonymousLifetime / time.Second),
		})
	} else {
		secret := s.Secret
		body.RefreshSecret = &secret
	}
	httpx.JSON(w, status, body)
}

func (h *HTTP) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- same attributes as the issuing cookie
		Name: CookieName, Value: "", Path: cookiePath, HttpOnly: true, Secure: h.cookieSecure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
}

// writeServiceError maps service errors to the documented HTTP errors (docs/API.md §3).
func writeServiceError(w http.ResponseWriter, err error) bool {
	var rl *RateLimitedError
	var pow *PoWRequiredError
	switch {
	case err == nil:
		return false
	case errors.As(err, &rl):
		httpx.RateLimited(w, "rate_limited", rl.Wait)
	case errors.As(err, &pow):
		httpx.JSON(w, http.StatusPreconditionRequired, api.PowRequired{
			Error: "pow_required", Message: "Solve the challenge to create a device from this network.",
			Challenge: api.PowChallenge{Token: pow.Token, Difficulty: pow.Difficulty, ExpiresIn: int(PoWTTL.Seconds())},
		})
	case errors.Is(err, ErrInvalidInput):
		httpx.BadRequest(w, "Check the device name and platform.")
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrDeviceInactive):
		httpx.Error(w, http.StatusUnauthorized, "device_token_invalid", "This device is no longer active.")
	default:
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
	}
	return true
}

func (h *HTTP) challenge(w http.ResponseWriter, r *http.Request) {
	tok, diff, err := h.svc.Challenge(h.addrKey(r))
	if writeServiceError(w, err) {
		return
	}
	httpx.JSON(w, http.StatusOK, api.PowChallenge{Token: tok, Difficulty: diff, ExpiresIn: int(PoWTTL.Seconds())})
}

func (h *HTTP) create(w http.ResponseWriter, r *http.Request) {
	var req api.CreateDeviceRequest
	if err := httpx.Decode(r, &req, maxBody, false); err != nil || !req.Transport.Valid() {
		httpx.BadRequest(w, "Expected platform and transport (cookie or body).")
		return
	}
	in := CreateInput{Platform: req.Platform}
	if req.DisplayName != nil {
		in.DisplayName = *req.DisplayName
	}
	if req.Pow != nil {
		in.PoWToken, in.PoWSolution = req.Pow.Token, req.Pow.Solution
	}
	s, err := h.svc.Create(r.Context(), h.addrKey(r), in)
	if writeServiceError(w, err) {
		return
	}
	h.writeSession(w, http.StatusCreated, s, req.Transport == api.CreateDeviceRequestTransportCookie)
}

func (h *HTTP) refresh(w http.ResponseWriter, r *http.Request) {
	var req api.RefreshRequest
	if err := httpx.Decode(r, &req, maxBody, true); err != nil {
		httpx.BadRequest(w, "Invalid refresh request.")
		return
	}
	secret, viaCookie := "", false
	if req.RefreshSecret != nil && *req.RefreshSecret != "" {
		secret = *req.RefreshSecret
	} else {
		// Cookie refresh requires a custom header that cross-site pages cannot send without a CORS
		// preflight, which the server never answers (CSRF protection, docs/SECURITY_MODEL.md §4).
		if r.Header.Get(refreshHeader) != "1" {
			httpx.Error(w, http.StatusForbidden, "csrf_header_missing", "Missing X-SA-Refresh header.")
			return
		}
		c, err := r.Cookie(CookieName)
		if err != nil || c.Value == "" {
			httpx.Error(w, http.StatusUnauthorized, "refresh_invalid", "No device credentials.")
			return
		}
		secret, viaCookie = c.Value, true
	}
	s, err := h.svc.Refresh(r.Context(), secret)
	switch {
	case errors.Is(err, ErrSecretReused):
		if viaCookie {
			h.clearCookie(w)
		}
		httpx.Error(w, http.StatusUnauthorized, "refresh_reused", "These device credentials were already used; the device was signed out for safety.")
		return
	case errors.Is(err, ErrSecretUnknown), errors.Is(err, ErrDeviceInactive):
		if viaCookie {
			h.clearCookie(w)
		}
		httpx.Error(w, http.StatusUnauthorized, "refresh_invalid", "Device credentials are not valid.")
		return
	}
	if writeServiceError(w, err) {
		return
	}
	useCookie := viaCookie
	if req.Transport != nil {
		useCookie = *req.Transport == api.RefreshRequestTransportCookie
	}
	h.writeSession(w, http.StatusOK, s, useCookie)
}

func (h *HTTP) current(w http.ResponseWriter, r *http.Request) {
	id, _ := access.FromContext(r.Context())
	d, err := h.svc.Get(r.Context(), id.DeviceID)
	if writeServiceError(w, err) {
		return
	}
	httpx.JSON(w, http.StatusOK, toAPIDevice(d))
}

func (h *HTTP) rename(w http.ResponseWriter, r *http.Request) {
	id, _ := access.FromContext(r.Context())
	var req api.UpdateDeviceRequest
	if err := httpx.Decode(r, &req, maxBody, false); err != nil {
		httpx.BadRequest(w, "Expected display_name.")
		return
	}
	d, err := h.svc.Rename(r.Context(), id.DeviceID, req.DisplayName)
	if writeServiceError(w, err) {
		return
	}
	httpx.JSON(w, http.StatusOK, toAPIDevice(d))
}

func (h *HTTP) reset(w http.ResponseWriter, r *http.Request) {
	id, _ := access.FromContext(r.Context())
	var req api.ResetDeviceRequest
	if err := httpx.Decode(r, &req, maxBody, true); err != nil {
		httpx.BadRequest(w, "Invalid reset request.")
		return
	}
	s, err := h.svc.Reset(r.Context(), id.DeviceID, h.addrKey(r))
	if writeServiceError(w, err) {
		return
	}
	cookie := req.Transport == nil || *req.Transport == api.ResetDeviceRequestTransportCookie
	h.writeSession(w, http.StatusCreated, s, cookie)
}
