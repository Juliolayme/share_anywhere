package clock

import (
	"testing"
	"time"
)

func TestFakeAndReal(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f := NewFake(t0)
	f.Advance(time.Minute)
	if !f.Now().Equal(t0.Add(time.Minute)) {
		t.Fatal("fake did not advance")
	}
	if d := time.Since(Real{}.Now()); d < 0 || d > time.Second {
		t.Fatal("real clock off")
	}
}
