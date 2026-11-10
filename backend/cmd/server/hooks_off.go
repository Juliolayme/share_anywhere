//go:build !testhooks

package main

import (
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/config"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
)

// Production builds have no test hooks and use the real clock.
func newClock(config.Config) clock.Clock { return clock.Real{} }

func testHooks(config.Config, clock.Clock, *sharing.Service, *sharing.ProtectedMode) []func(*access.Router) {
	return nil
}
