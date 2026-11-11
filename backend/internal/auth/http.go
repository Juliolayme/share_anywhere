package auth

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
)

const (
	maxAuthBody    = 4 << 10
	maxKeysBody    = 512 << 10 // up to 100 device blobs of 4 KB, base64url
	maxHistoryBody = 96 << 10  // 64 KB ciphertext, base64url, plus fields
)

// Cookies writes the device-layer cookies (implemented by *devices.HTTP, passed by cmd/server).
type Cookies interface {
	// WriteSession answers with a device session in the device's fixed refresh transport (the Web gets a new
	// sa_device cookie; native clients get refresh_secret in the body).
	WriteSession(w http.ResponseWriter, status int, s devices.Session)
	// SetAccountBinding sets the browser-session sa_acct cookie of a not-added Web account session.
	SetAccountBinding(w http.ResponseWriter, value string)
	// ClearAccountBinding expires the sa_acct cookie.
	ClearAccountBinding(w http.ResponseWriter)
}

// HTTP exposes the account endpoints (docs/API.md §2.4).
type HTTP struct {
	svc     *Service
	ips     *clientip.Resolver
	cookies Cookies
}

// NewHTTP returns the account handlers.
func NewHTTP(svc *Service, ips *clientip.Resolver, cookies Cookies) *HTTP {
	return &HTTP{svc: svc, ips: ips, cookies: cookies}
}

// bindCookie sets the sa_acct cookie for a not-added Web session and clears a stale one otherwise; native
// (body-transport) devices never get it (docs/ADR/0013-session-hardening.md).
func (h *HTTP) bindCookie(w http.ResponseWriter, d devices.Device, binding string) {
	switch {
	case binding != "":
		h.cookies.SetAccountBinding(w, binding)
	case d.Transport == devices.TransportCookie:
		h.cookies.ClearAccountBinding(w)
	}
}

// Register adds the routes with their access levels (shared/protocol/openapi.yaml x-sa-access).
func (h *HTTP) Register(r *access.Router) {
	r.Handle(http.MethodPost, "/v1/auth/signup", access.Device, h.signup)
	r.Handle(http.MethodPost, "/v1/auth/signin", access.Device, h.signin)
	r.Handle(http.MethodPost, "/v1/auth/signout", access.Account, h.signout)
	r.Handle(http.MethodPost, "/v1/auth/password-reset/request", access.Public, h.resetRequest)
	r.Handle(http.MethodPost, "/v1/auth/password-reset/confirm", access.Public, h.resetConfirm)
	r.Handle(http.MethodGet, "/v1/me", access.Account, h.getMe)
	r.Handle(http.MethodPatch, "/v1/me", access.AccountDevice, h.patchMe)
	r.Handle(http.MethodPost, "/v1/me/password", access.Account, h.changePassword)
	r.Handle(http.MethodPost, "/v1/devices/current/add", access.Account, h.addCurrent)
	r.Handle(http.MethodGet, "/v1/devices", access.Account, h.listDevices)
	r.Handle(http.MethodPatch, "/v1/devices/{id}", access.AccountDevice, h.renameDevice)
	r.Handle(http.MethodDelete, "/v1/devices/{id}", access.AccountDevice, h.revokeDevice)
	r.Handle(http.MethodGet, "/v1/keys", access.AccountDevice, h.keys)
	r.Handle(http.MethodPut, "/v1/keys/device", access.AccountDevice, h.registerKey)
	r.Handle(http.MethodPost, "/v1/keys/setup", access.AccountDevice, h.setupKeys)
	r.Handle(http.MethodGet, "/v1/keys/recovery", access.AccountDevice, h.recovery)
	r.Handle(http.MethodPost, "/v1/keys/rotate", access.AccountDevice, h.rotate)
	r.Handle(http.MethodGet, "/v1/keys/chain", access.AccountDevice, h.chain)
	r.Handle(http.MethodDelete, "/v1/keys/pending/{key_version}", access.AccountDevice, h.ackPending)
	r.Handle(http.MethodPost, "/v1/keys/pairings", access.AccountDevice, h.createPairing)
	r.Handle(http.MethodGet, "/v1/keys/pairings/{pairing_id}", access.AccountDevice, h.pairingResult)
	r.Handle(http.MethodGet, "/v1/keys/pairings/by-code/{code}", access.AccountDevice, h.lookupPairing)
	r.Handle(http.MethodPost, "/v1/keys/pairings/by-code/{code}/wrap", access.AccountDevice, h.wrapPairing)
	r.Handle(http.MethodGet, "/v1/history/entries", access.AccountDevice, h.entries)
	r.Handle(http.MethodPost, "/v1/history/entries", access.AccountDevice, h.addEntry)
	r.Handle(http.MethodDelete, "/v1/history/entries/{entry_id}", access.AccountDevice, h.deleteEntry)
	r.Handle(http.MethodDelete, "/v1/history", access.AccountDevice, h.clearHistory)
}

func ident(r *http.Request) access.Identity {
	id, _ := access.FromContext(r.Context())
	return id
}

func (h *HTTP) ipKey(r *http.Request) string { return clientip.Key(h.ips.FromRequest(r)) }

func (h *HTTP) fail(w http.ResponseWriter, err error) {
	var e *Error
	switch {
	case errors.As(err, &e) && e.Status == http.StatusTooManyRequests:
		httpx.RateLimited(w, e.Code, e.Wait)
	case errors.As(err, &e) && e.Extra != nil:
		body := map[string]any{"error": e.Code, "message": e.Msg}
		for k, v := range e.Extra {
			body[k] = v
		}
		httpx.JSON(w, e.Status, body)
	case errors.As(err, &e):
		httpx.Error(w, e.Status, e.Code, e.Msg)
	case errors.Is(err, devices.ErrNotFound), errors.Is(err, devices.ErrDeviceInactive):
		httpx.Error(w, http.StatusUnauthorized, "device_token_invalid", "This device is no longer active.")
	default:
		h.svc.cfg.Log.Error("account request failed", "error", err.Error())
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
	}
}

type credentialsBody struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	AddDevice   *bool  `json:"add_device"`
	CopyHistory *bool  `json:"copy_history"`
}

func (b credentialsBody) creds() Credentials {
	c := Credentials{Email: b.Email, Password: b.Password, AddDevice: true}
	if b.AddDevice != nil {
		c.AddDevice = *b.AddDevice
	}
	// "Copy this device's transfer history" applies only to an added device; the client performs the import
	// through POST /v1/history/entries, so the server only validates it.
	c.CopyHistory = b.CopyHistory != nil && *b.CopyHistory && c.AddDevice
	return c
}

type accountRef struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type deviceRef struct {
	ID    string `json:"id"`
	Added bool   `json:"added"`
}

type authResponse struct {
	AccessToken string     `json:"access_token"`
	ExpiresIn   int        `json:"expires_in"`
	Account     accountRef `json:"account"`
	Device      deviceRef  `json:"device"`
}

func toAuthResponse(r AuthResult) authResponse {
	return authResponse{
		AccessToken: r.Session.AccessToken, ExpiresIn: r.Session.ExpiresIn,
		Account: accountRef{ID: r.UserID, Email: r.Email},
		Device:  deviceRef{ID: r.Session.Device.ID, Added: r.Session.Account.Added},
	}
}

func (h *HTTP) signup(w http.ResponseWriter, r *http.Request) {
	var b credentialsBody
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected email and password.")
		return
	}
	res, err := h.svc.SignUp(r.Context(), ident(r), h.ipKey(r), b.creds())
	if err != nil {
		h.fail(w, err)
		return
	}
	h.bindCookie(w, res.Session.Device, res.Binding)
	httpx.JSON(w, http.StatusCreated, toAuthResponse(res))
}

func (h *HTTP) signin(w http.ResponseWriter, r *http.Request) {
	var b credentialsBody
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected email and password.")
		return
	}
	res, err := h.svc.SignIn(r.Context(), ident(r), h.ipKey(r), b.creds())
	if err != nil {
		h.fail(w, err)
		return
	}
	h.bindCookie(w, res.Session.Device, res.Binding)
	httpx.JSON(w, http.StatusOK, toAuthResponse(res))
}

func (h *HTTP) signout(w http.ResponseWriter, r *http.Request) {
	var none struct{}
	if err := httpx.Decode(r, &none, maxAuthBody, true); err != nil {
		httpx.BadRequest(w, "This request takes no body.")
		return
	}
	s, err := h.svc.SignOut(r.Context(), ident(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	h.bindCookie(w, s.Device, "")
	h.cookies.WriteSession(w, http.StatusOK, s)
}

func (h *HTTP) resetRequest(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Email string `json:"email"`
	}
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected email.")
		return
	}
	if err := h.svc.RequestReset(r.Context(), h.ipKey(r), b.Email); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *HTTP) resetConfirm(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected token and password.")
		return
	}
	if err := h.svc.ConfirmReset(r.Context(), b.Token, b.Password); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) getMe(w http.ResponseWriter, r *http.Request) {
	m, err := h.svc.GetMe(r.Context(), ident(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, m)
}

func (h *HTTP) patchMe(w http.ResponseWriter, r *http.Request) {
	var b struct {
		HistorySync *bool `json:"history_sync"`
	}
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected history_sync.")
		return
	}
	m, err := h.svc.UpdateMe(r.Context(), ident(r), b.HistorySync)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, m)
}

func (h *HTTP) changePassword(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected current_password and new_password.")
		return
	}
	if err := h.svc.ChangePassword(r.Context(), ident(r), b.Current, b.New); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type tokenResponse struct {
	AccessToken string    `json:"access_token"`
	ExpiresIn   int       `json:"expires_in"`
	Device      deviceRef `json:"device"`
}

func (h *HTTP) addCurrent(w http.ResponseWriter, r *http.Request) {
	var b struct {
		CopyHistory *bool `json:"copy_history"`
	}
	if err := httpx.Decode(r, &b, maxAuthBody, true); err != nil {
		httpx.BadRequest(w, "Expected copy_history or no body.")
		return
	}
	s, err := h.svc.AddCurrent(r.Context(), ident(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	h.bindCookie(w, s.Device, "")
	httpx.JSON(w, http.StatusOK, tokenResponse{AccessToken: s.AccessToken, ExpiresIn: s.ExpiresIn, Device: deviceRef{ID: s.Device.ID, Added: s.Account.Added}})
}

func (h *HTTP) listDevices(w http.ResponseWriter, r *http.Request) {
	list, err := h.svc.ListDevices(r.Context(), ident(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"devices": list})
}

func (h *HTTP) renameDevice(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name string `json:"name"`
	}
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected name.")
		return
	}
	d, err := h.svc.RenameDevice(r.Context(), ident(r), r.PathValue("id"), b.Name)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, d)
}

func (h *HTTP) revokeDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isUUID(id) {
		h.fail(w, ErrNotFound)
		return
	}
	if err := h.svc.RevokeDevice(r.Context(), ident(r), id); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) keys(w http.ResponseWriter, r *http.Request) {
	k, err := h.svc.Keys(r.Context(), ident(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, k)
}

func (h *HTTP) registerKey(w http.ResponseWriter, r *http.Request) {
	var b RegisterKeyInput
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected public_key, key_version, and proof.")
		return
	}
	if err := h.svc.RegisterDeviceKey(r.Context(), ident(r), b); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) setupKeys(w http.ResponseWriter, r *http.Request) {
	var b SetupInput
	if err := httpx.Decode(r, &b, maxKeysBody, false); err != nil {
		httpx.BadRequest(w, "Expected recovery_public_key, salt, params, recovery_blob, verify_key, and recovery_anchor.")
		return
	}
	v, err := h.svc.SetupKeys(r.Context(), ident(r), b)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]int{"key_version": v})
}

func (h *HTTP) recovery(w http.ResponseWriter, r *http.Request) {
	rec, err := h.svc.GetRecovery(r.Context(), ident(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, rec)
}

func (h *HTTP) rotate(w http.ResponseWriter, r *http.Request) {
	var b RotateInput
	if err := httpx.Decode(r, &b, maxKeysBody, false); err != nil {
		httpx.BadRequest(w, "Expected key_version, recovery_blob, chain_blob, device_blobs, verify_key, and signature.")
		return
	}
	v, err := h.svc.Rotate(r.Context(), ident(r), b)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]int{"key_version": v})
}

func (h *HTTP) chain(w http.ResponseWriter, r *http.Request) {
	c, err := h.svc.Chain(r.Context(), ident(r))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, c)
}

func (h *HTTP) ackPending(w http.ResponseWriter, r *http.Request) {
	v, err := strconv.Atoi(r.PathValue("key_version"))
	if err != nil || v < 1 {
		h.fail(w, ErrNotFound)
		return
	}
	if err := h.svc.AckPending(r.Context(), ident(r), v); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) createPairing(w http.ResponseWriter, r *http.Request) {
	var b struct {
		EphemeralPublicKey string `json:"ephemeral_public_key"`
	}
	if err := httpx.Decode(r, &b, maxAuthBody, false); err != nil {
		httpx.BadRequest(w, "Expected ephemeral_public_key.")
		return
	}
	p, err := h.svc.CreatePairing(r.Context(), ident(r), h.ipKey(r), b.EphemeralPublicKey)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, p)
}

func (h *HTTP) lookupPairing(w http.ResponseWriter, r *http.Request) {
	p, err := h.svc.LookupPairing(r.Context(), ident(r), h.ipKey(r), r.PathValue("code"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

func (h *HTTP) wrapPairing(w http.ResponseWriter, r *http.Request) {
	var b WrapInput
	if err := httpx.Decode(r, &b, maxKeysBody, false); err != nil {
		httpx.BadRequest(w, "Expected key_version, sender_public_key, and blob.")
		return
	}
	if err := h.svc.WrapPairing(r.Context(), ident(r), r.PathValue("code"), b); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) pairingResult(w http.ResponseWriter, r *http.Request) {
	p, err := h.svc.PairingResult(r.Context(), ident(r), r.PathValue("pairing_id"))
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

func (h *HTTP) entries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	after, limit := int64(0), 200
	if v := q.Get("after"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			httpx.BadRequest(w, "after must be a non-negative integer.")
			return
		}
		after = n
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 500 {
			httpx.BadRequest(w, "limit must be between 1 and 500.")
			return
		}
		limit = n
	}
	p, err := h.svc.Entries(r.Context(), ident(r), after, limit)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

func (h *HTTP) addEntry(w http.ResponseWriter, r *http.Request) {
	var b EntryInput
	if err := httpx.Decode(r, &b, maxHistoryBody, false); err != nil {
		httpx.BadRequest(w, "Expected entry_id, key_version, nonce, and ciphertext.")
		return
	}
	seq, err := h.svc.AddEntry(r.Context(), ident(r), b)
	if err != nil {
		h.fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]int64{"seq": seq})
}

func (h *HTTP) deleteEntry(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DeleteEntry(r.Context(), ident(r), r.PathValue("entry_id")); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTP) clearHistory(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.ClearHistory(r.Context(), ident(r)); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
