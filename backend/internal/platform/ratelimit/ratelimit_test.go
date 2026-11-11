package ratelimit

import (
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

func TestBurstThenRefill(t *testing.T) {
	c := clock.NewFake(time.Unix(0, 0))
	l := New(Rule{Limit: 10, Window: time.Hour, Burst: 3}, c)
	for i := 0; i < 3; i++ {
		if ok, _ := l.Allow("ip"); !ok {
			t.Fatalf("request %d should pass", i)
		}
	}
	ok, wait := l.Allow("ip")
	if ok || wait <= 0 || wait > 6*time.Minute+time.Second {
		t.Fatalf("4th should be denied with ~6 min wait, got ok=%v wait=%v", ok, wait)
	}
	c.Advance(6 * time.Minute)
	if ok, _ := l.Allow("ip"); !ok {
		t.Fatal("token should refill after 6 minutes (10/hour)")
	}
	if ok, _ := l.Allow("other"); !ok {
		t.Fatal("keys are independent")
	}
}

func TestPeekDoesNotSpend(t *testing.T) {
	l := New(Rule{Limit: 1, Window: time.Minute}, clock.NewFake(time.Unix(0, 0)))
	for i := 0; i < 2; i++ {
		if !l.Peek("k") {
			t.Fatal("peek should not spend")
		}
	}
	l.Allow("k")
	if l.Peek("k") {
		t.Fatal("bucket should be empty")
	}
}

func TestSweepKeepsMemoryBounded(t *testing.T) {
	c := clock.NewFake(time.Unix(0, 0))
	l := New(Rule{Limit: 1, Window: time.Second}, c)
	for i := 0; i < 5000; i++ {
		l.Allow(string(rune('a'+i%26)) + time.Duration(i).String())
		c.Advance(time.Second)
	}
	if len(l.buckets) > 1100 {
		t.Fatalf("buckets not swept: %d", len(l.buckets))
	}
}

func TestCheckDoesNotSpendAndReportsWait(t *testing.T) {
	l := New(Rule{Limit: 2, Window: time.Hour}, clock.NewFake(time.Unix(0, 0)))
	if ok, wait := l.Check("k"); !ok || wait != 0 {
		t.Fatalf("fresh bucket: %v %v", ok, wait)
	}
	l.Allow("k")
	l.Allow("k")
	ok, wait := l.Check("k")
	if ok || wait < 29*time.Minute || wait > 31*time.Minute {
		t.Fatalf("empty bucket should wait ~30 min: %v %v", ok, wait)
	}
	if ok2, _ := l.Check("k"); ok2 {
		t.Fatal("check must not refill or spend")
	}
}
