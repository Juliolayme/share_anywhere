// Package ratelimit implements in-memory token buckets keyed by IP or device (docs/SECURITY_MODEL.md §5).
// The MVP runs a single backend instance; multiple instances need a shared store and an ADR.
package ratelimit

import (
	"math"
	"sync"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

// Rule is "Limit events per Window", allowing bursts up to Burst (defaults to Limit).
type Rule struct {
	Limit  int
	Window time.Duration
	Burst  int
}

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter is a set of token buckets sharing one rule.
type Limiter struct {
	rule    Rule
	clock   clock.Clock
	mu      sync.Mutex
	buckets map[string]*bucket
	sweeps  int
}

// New returns a limiter for rule.
func New(rule Rule, c clock.Clock) *Limiter {
	if rule.Burst <= 0 {
		rule.Burst = rule.Limit
	}
	return &Limiter{rule: rule, clock: c, buckets: map[string]*bucket{}}
}

func (l *Limiter) ratePerSecond() float64 { return float64(l.rule.Limit) / l.rule.Window.Seconds() }

// Allow spends one token for key. When denied it reports how long until a token is available.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock.Now()
	b := l.refill(key, now)
	if b.tokens >= 1 {
		b.tokens--
		l.maybeSweep(now)
		return true, 0
	}
	wait := time.Duration(math.Ceil((1-b.tokens)/l.ratePerSecond()*1000)) * time.Millisecond
	return false, wait
}

// Check reports whether a token is available without spending it and, when not, how long until one is.
// Callers that limit only failures check first and spend with Allow after a failure.
func (l *Limiter) Check(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.refill(key, l.clock.Now())
	if b.tokens >= 1 {
		return true, 0
	}
	return false, time.Duration(math.Ceil((1-b.tokens)/l.ratePerSecond()*1000)) * time.Millisecond
}

// Peek reports whether a token is available without spending it.
func (l *Limiter) Peek(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.refill(key, l.clock.Now()).tokens >= 1
}

func (l *Limiter) refill(key string, now time.Time) *bucket {
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(l.rule.Burst), last: now}
		l.buckets[key] = b
		return b
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens = math.Min(float64(l.rule.Burst), b.tokens+elapsed*l.ratePerSecond())
		b.last = now
	}
	return b
}

// maybeSweep drops full buckets now and then so memory stays bounded.
func (l *Limiter) maybeSweep(now time.Time) {
	l.sweeps++
	if l.sweeps%1024 != 0 {
		return
	}
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.ratePerSecond() >= float64(l.rule.Burst) {
			delete(l.buckets, k)
		}
	}
}
