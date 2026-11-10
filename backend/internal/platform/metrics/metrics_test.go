package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegistryExposition(t *testing.T) {
	r := New()
	c := r.Counter("sa_test_total", "Test counter.")
	c.Inc()
	c.Add(2)
	c.Add(-5)
	if r.Counter("sa_test_total", "again") != c {
		t.Fatal("same name returns the same counter")
	}
	r.Gauge("sa_test_active", "Test gauge.", func() float64 { return 1 })
	rec := httptest.NewRecorder()
	r.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()
	for _, want := range []string{"# TYPE sa_test_total counter\nsa_test_total 3\n", "# TYPE sa_test_active gauge\nsa_test_active 1\n"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in\n%s", want, body)
		}
	}
	if strings.Index(body, "sa_test_active") > strings.Index(body, "sa_test_total") {
		t.Fatal("metrics are sorted by name")
	}
}
