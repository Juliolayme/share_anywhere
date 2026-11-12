package objectstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

func exercise(t *testing.T, s Store) {
	t.Helper()
	ctx := context.Background()
	body := make([]byte, 300_000)
	_, _ = rand.Read(body)
	key := "objects/test-" + time.Now().Format("150405.000000") + "/0"
	if err := s.Put(ctx, key, body); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, key)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("round trip: %v (%d bytes)", err, len(got))
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted object still readable: %v", err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatalf("deleting a missing object is not an error: %v", err)
	}
}

func TestMemoryStore(t *testing.T) {
	m := NewMemory()
	exercise(t, m)
	if m.Len() != 0 {
		t.Fatal("memory store not empty")
	}
}

// TestS3StoreAgainstGateway runs against the S3-compatible gateway of the CI job (TEST_S3_ENDPOINT).
func TestS3StoreAgainstGateway(t *testing.T) {
	ep := os.Getenv("TEST_S3_ENDPOINT")
	if ep == "" {
		t.Skip("TEST_S3_ENDPOINT not set")
	}
	s := &S3{Endpoint: ep, Region: "us-east-1", Bucket: "sa-objectstore-test", AccessKey: os.Getenv("TEST_S3_ACCESS_KEY"),
		SecretKey: os.Getenv("TEST_S3_SECRET_KEY")}
	if err := s.EnsureBucket(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureBucket(context.Background()); err != nil {
		t.Fatalf("an existing bucket is fine: %v", err)
	}
	exercise(t, s)
	bad := *s
	bad.SecretKey = "wrong"
	if err := bad.Put(context.Background(), "x/0", []byte("x")); err == nil {
		t.Fatal("a wrong secret must be refused")
	}
}

// TestSigV4HeaderShape checks the Authorization header shape for a request shaped like AWS's GET Object example
// (s3 "Example: GET Object", examplebucket, 2013-05-24).
func TestSigV4HeaderShape(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	s := &S3{Endpoint: srv.URL, Region: "us-east-1", Bucket: "examplebucket", AccessKey: "AKIAIOSFODNN7EXAMPLE",
		SecretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", Clock: clock.NewFake(time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))}
	if _, err := s.Get(context.Background(), "test.txt"); err != nil {
		t.Fatal(err)
	}
	// The host differs from the AWS example (it signs examplebucket.s3.amazonaws.com and a Range header), so check
	// the structure and determinism rather than the published signature.
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "+
		"SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=") || len(auth) != len(strings.Split(auth, "Signature=")[0])+len("Signature=")+64 {
		t.Fatalf("authorization header: %s", auth)
	}
	first := auth
	if _, err := s.Get(context.Background(), "test.txt"); err != nil || auth != first {
		t.Fatal("signing is deterministic for the same request and time")
	}
}

func TestSigningKeyDerivationMatchesAWS(t *testing.T) {
	// AWS documentation "Examples of how to derive a signing key for Signature Version 4".
	key := mac([]byte("AWS4"+"wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"), "20120215")
	key = mac(key, "us-east-1")
	key = mac(key, "iam")
	key = mac(key, "aws4_request")
	const want = "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
	if got := hexs(key); got != want {
		t.Fatalf("signing key %s", got)
	}
	if uriEncode("a b/ü~", true) != "a%20b%2F%C3%BC~" {
		t.Fatal(uriEncode("a b/ü~", true))
	}
}

func hexs(b []byte) string {
	const d = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, d[c>>4], d[c&15])
	}
	return string(out)
}
