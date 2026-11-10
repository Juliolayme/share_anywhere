package sharing

import (
	"sync"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

// ProtectedMode is the global circuit breaker for code guessing (docs/SECURITY_MODEL.md §3.1): when failed
// code lookups across the service reach `threshold` within a minute, every join made with a six-digit code
// needs the sender's approval for 30 minutes after the condition clears. Single-instance MVP: in memory.
type ProtectedMode struct {
	mu        sync.Mutex
	clock     clock.Clock
	threshold int
	failures  []time.Time
	until     time.Time
	forced    *bool
	// forcedUntil is reported while forced (display only).
	forcedUntil time.Time
}

// NewProtectedMode returns a breaker that trips at threshold failures per minute.
func NewProtectedMode(c clock.Clock, threshold int) *ProtectedMode {
	return &ProtectedMode{clock: c, threshold: threshold}
}

// RecordFailure counts one failed lookup and reports whether this failure switched protected mode on.
func (p *ProtectedMode) RecordFailure() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock.Now()
	cut := now.Add(-time.Minute)
	keep := p.failures[:0]
	for _, t := range p.failures {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	p.failures = append(keep, now)
	if len(p.failures) >= p.threshold {
		wasActive := now.Before(p.until)
		p.until = now.Add(ProtectedDuration)
		return !wasActive
	}
	return false
}

// Active reports whether protected mode applies now, and until when.
func (p *ProtectedMode) Active() (bool, time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.forced != nil {
		return *p.forced, p.forcedUntil
	}
	return p.clock.Now().Before(p.until), p.until
}

// Force overrides the breaker (test-only admin hook); nil returns to automatic.
func (p *ProtectedMode) Force(on *bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Forcing never touches the automatic alarm window, so returning to automatic restores the real state.
	p.forced = on
	p.forcedUntil = p.clock.Now().Add(ProtectedDuration)
}
