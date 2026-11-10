//go:build testhooks

package main

import (
	"net/http"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/config"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpx"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// Test builds (go build -tags testhooks, used only by docker-compose.ci.yml) add an adjustable clock and
// admin hooks so end-to-end specs can move time and force protected mode (docs/TESTING_AND_CI.md §3).
// They are registered only with SA_ENV=test.

func newClock(cfg config.Config) clock.Clock {
	if cfg.Env == config.EnvTest {
		return &clock.Offset{}
	}
	return clock.Real{}
}

func testHooks(cfg config.Config, clk clock.Clock, svc *sharing.Service, _ *sharing.ProtectedMode) []func(*access.Router) {
	off, ok := clk.(*clock.Offset)
	if cfg.Env != config.EnvTest || !ok {
		return nil
	}
	return []func(*access.Router){func(r *access.Router) {
		r.Handle(http.MethodPost, "/v1/_test/clock", access.Public, func(w http.ResponseWriter, req *http.Request) {
			var in struct {
				AdvanceSeconds int `json:"advance_seconds"`
			}
			if err := httpx.Decode(req, &in, 1<<10, false); err != nil || in.AdvanceSeconds < 0 || in.AdvanceSeconds > 7*24*3600 {
				httpx.BadRequest(w, "advance_seconds between 0 and 604800")
				return
			}
			off.Advance(time.Duration(in.AdvanceSeconds) * time.Second)
			_, _ = svc.Tick(req.Context())
			httpx.JSON(w, http.StatusOK, map[string]any{"server_time": off.Now().UTC()})
		})
		r.Handle(http.MethodPost, "/v1/_test/lockout", access.Device, func(w http.ResponseWriter, req *http.Request) {
			id, _ := access.FromContext(req.Context())
			svc.LockDeviceForTest(id.DeviceID, sharing.LockoutDuration)
			httpx.JSON(w, http.StatusOK, map[string]any{"locked_for_s": int(sharing.LockoutDuration.Seconds())})
		})
		r.Handle(http.MethodPost, "/v1/_test/protected-mode", access.Public, func(w http.ResponseWriter, req *http.Request) {
			var in struct {
				Active *bool `json:"active"`
			}
			if err := httpx.Decode(req, &in, 1<<10, false); err != nil {
				httpx.BadRequest(w, "active: true, false or null")
				return
			}
			on, until := svc.SetProtected(in.Active)
			httpx.JSON(w, http.StatusOK, map[string]any{"active": on, "until": until})
		})
	}}
}
