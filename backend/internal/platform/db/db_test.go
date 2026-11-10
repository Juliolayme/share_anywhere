package db

import (
	"context"
	"os"
	"testing"
)

func TestOpenRejectsBadURL(t *testing.T) {
	if _, err := Open(context.Background(), "::not a url::"); err == nil {
		t.Fatal("expected an error for a malformed URL")
	}
}

// TestOpenAndPing runs against a real database when TEST_DATABASE_URL is set (CI service container).
func TestOpenAndPing(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := Open(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
}
