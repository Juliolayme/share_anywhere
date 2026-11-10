package sharing

import (
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

func TestProtectedModeTripsAndClears(t *testing.T) {
	c := clock.NewFake(time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC))
	p := NewProtectedMode(c, 5)
	for i := 0; i < 4; i++ {
		if p.RecordFailure() {
			t.Fatal("tripped too early")
		}
		c.Advance(time.Second)
	}
	if on, _ := p.Active(); on {
		t.Fatal("not active below threshold")
	}
	if !p.RecordFailure() {
		t.Fatal("fifth failure within a minute must trip")
	}
	if on, _ := p.Active(); !on {
		t.Fatal("active after trip")
	}
	if p.RecordFailure() {
		t.Fatal("already active: no new transition")
	}
	c.Advance(ProtectedDuration + time.Second)
	if on, _ := p.Active(); on {
		t.Fatal("clears 30 minutes after the last alarm")
	}
	// Failures spread over more than a minute never trip.
	for i := 0; i < 10; i++ {
		c.Advance(20 * time.Second)
		if p.RecordFailure() {
			t.Fatal("slow failures must not trip")
		}
	}
	on := true
	p.Force(&on)
	if a, _ := p.Active(); !a {
		t.Fatal("forced on")
	}
	p.Force(nil)
	if a, _ := p.Active(); a {
		t.Fatal("returning to automatic must restore the real (inactive) state")
	}
}
