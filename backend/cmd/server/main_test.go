package main

import "testing"

func TestListenPort(t *testing.T) {
	cases := map[string]struct {
		in   string
		want int
		ok   bool
	}{
		"empty":      {"", 8080, true},
		"port only":  {":9090", 9090, true},
		"host:port":  {"0.0.0.0:8081", 8081, true},
		"no port":    {"localhost", 0, false},
		"not number": {":http", 0, false},
		"too big":    {":70000", 0, false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := listenPort(tc.in)
			if (err == nil) != tc.ok || got != tc.want {
				t.Fatalf("listenPort(%q) = %d, %v", tc.in, got, err)
			}
		})
	}
}
