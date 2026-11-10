// Package clock abstracts time so lifetimes and rate limits can be tested without sleeping.
package clock

import (
	"sync"
	"time"
)

// Clock returns the current time.
type Clock interface {
	Now() time.Time
}

// Real is the system clock.
type Real struct{}

// Now returns time.Now().
func (Real) Now() time.Time { return time.Now() }

// Fake is a manually advanced clock for tests.
type Fake struct {
	mu  sync.Mutex
	now time.Time
}

// NewFake returns a fake clock set to t.
func NewFake(t time.Time) *Fake { return &Fake{now: t} }

// Now returns the fake time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// Advance moves the fake time forward.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	f.mu.Unlock()
}
