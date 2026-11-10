// Package metrics is a minimal Prometheus-text registry for aggregate counters and gauges
// (docs/SECURITY_MODEL.md §8: metrics are aggregates, never per person). It is served on a separate,
// internal listener (SA_METRICS_ADDR), never through the public edge.
package metrics

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
)

// Counter only goes up.
type Counter struct {
	name, help string
	v          atomic.Int64
}

// Inc adds one.
func (c *Counter) Inc() { c.v.Add(1) }

// Add adds n (n ≥ 0).
func (c *Counter) Add(n int64) {
	if n > 0 {
		c.v.Add(n)
	}
}

// Value returns the current count.
func (c *Counter) Value() int64 { return c.v.Load() }

type gauge struct {
	name, help string
	fn         func() float64
}

// Registry holds named metrics.
type Registry struct {
	mu       sync.Mutex
	counters map[string]*Counter
	gauges   map[string]gauge
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{counters: map[string]*Counter{}, gauges: map[string]gauge{}}
}

// Counter returns the counter with this name, creating it once.
func (r *Registry) Counter(name, help string) *Counter {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.counters[name]; ok {
		return c
	}
	c := &Counter{name: name, help: help}
	r.counters[name] = c
	return c
}

// Gauge registers a gauge read at scrape time.
func (r *Registry) Gauge(name, help string, fn func() float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gauges[name] = gauge{name: name, help: help, fn: fn}
}

// Handler serves the Prometheus text exposition format.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		r.mu.Lock()
		var names []string
		for n := range r.counters {
			names = append(names, n)
		}
		for n := range r.gauges {
			names = append(names, n)
		}
		sort.Strings(names)
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		for _, n := range names {
			if c, ok := r.counters[n]; ok {
				_, _ = fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", n, c.help, n, n, c.Value())
			} else {
				g := r.gauges[n]
				_, _ = fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %g\n", n, g.help, n, n, g.fn())
			}
		}
		r.mu.Unlock()
	})
}
