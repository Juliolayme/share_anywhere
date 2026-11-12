// Package objectstore is the S3-compatible adapter behind Cloud Distribution (docs/ARCHITECTURE.md §6,
// docs/ADR/0030-cloud-distribution.md): put, get and delete small objects (one encrypted part each). S3 speaks
// SigV4 over path-style URLs to any S3-compatible endpoint (Versity Gateway in compose and CI); Memory is the local
// development and unit-test adapter. Contents are client-side ciphertext; this package never sees plaintext.
package objectstore

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
)

// ErrNotFound reports a missing object.
var ErrNotFound = errors.New("object not found")

// Store keeps objects by key.
type Store interface {
	Put(ctx context.Context, key string, body []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, key string) error
}

// Memory is an in-process store for development and tests (lost on restart).
type Memory struct {
	mu sync.Mutex
	m  map[string][]byte
}

// NewMemory returns an empty store.
func NewMemory() *Memory { return &Memory{m: map[string][]byte{}} }

// Put stores a copy of body.
func (s *Memory) Put(_ context.Context, key string, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = append([]byte(nil), body...)
	return nil
}

// Get returns a copy of the object.
func (s *Memory) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.m[key]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]byte(nil), b...), nil
}

// Delete removes the object (missing objects are not an error).
func (s *Memory) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, key)
	return nil
}

// Len reports how many objects are stored (tests).
func (s *Memory) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// S3 is a minimal SigV4 client for one bucket on an S3-compatible endpoint (path-style addressing).
type S3 struct {
	Endpoint  string // e.g. http://s3:7070
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	Client    *http.Client
	Clock     clock.Clock
}

// MaxObject bounds what Get reads back (a part is far smaller).
const MaxObject = 64 << 20

// EnsureBucket creates the bucket when it does not exist yet.
func (s *S3) EnsureBucket(ctx context.Context) error {
	res, err := s.do(ctx, http.MethodPut, "/"+s.Bucket, nil)
	if err != nil {
		return err
	}
	defer drain(res)
	if res.StatusCode == http.StatusOK || res.StatusCode == http.StatusConflict {
		return nil // created, or already there (BucketAlreadyOwnedByYou)
	}
	return statusErr("create bucket", res)
}

// Put uploads body under key.
func (s *S3) Put(ctx context.Context, key string, body []byte) error {
	res, err := s.do(ctx, http.MethodPut, s.path(key), body)
	if err != nil {
		return err
	}
	defer drain(res)
	if res.StatusCode != http.StatusOK {
		return statusErr("put", res)
	}
	return nil
}

// Get downloads the object at key.
func (s *S3) Get(ctx context.Context, key string) ([]byte, error) {
	res, err := s.do(ctx, http.MethodGet, s.path(key), nil)
	if err != nil {
		return nil, err
	}
	defer drain(res)
	switch res.StatusCode {
	case http.StatusOK:
		return io.ReadAll(io.LimitReader(res.Body, MaxObject))
	case http.StatusNotFound:
		return nil, ErrNotFound
	default:
		return nil, statusErr("get", res)
	}
}

// Delete removes the object at key (S3 answers 204 whether or not it existed).
func (s *S3) Delete(ctx context.Context, key string) error {
	res, err := s.do(ctx, http.MethodDelete, s.path(key), nil)
	if err != nil {
		return err
	}
	defer drain(res)
	if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNotFound {
		return statusErr("delete", res)
	}
	return nil
}

func (s *S3) path(key string) string { return "/" + s.Bucket + "/" + key }

func (s *S3) do(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	u, err := url.Parse(strings.TrimRight(s.Endpoint, "/") + escapePath(path))
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body)) // #nosec G704 -- operator-configured object store endpoint (SA_S3_ENDPOINT), never request input
	if err != nil {
		return nil, err
	}
	req.ContentLength = int64(len(body))
	now := time.Now().UTC()
	if s.Clock != nil {
		now = s.Clock.Now().UTC()
	}
	s.sign(req, body, now)
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	return client.Do(req) // #nosec G704 -- see above
}

// sign adds SigV4 headers (docs.aws.amazon.com "Signature Version 4 signing process"), payload hash included.
func (s *S3) sign(req *http.Request, body []byte, now time.Time) {
	amzDate := now.Format("20060102T150405Z")
	day := now.Format("20060102")
	sum := sha256.Sum256(body)
	payload := hex.EncodeToString(sum[:])
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payload)
	headers := map[string]string{
		"host":                 req.URL.Host,
		"x-amz-content-sha256": payload,
		"x-amz-date":           amzDate,
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, k := range names {
		canonHeaders.WriteString(k + ":" + strings.TrimSpace(headers[k]) + "\n")
	}
	signed := strings.Join(names, ";")
	canonical := strings.Join([]string{
		req.Method, req.URL.EscapedPath(), canonicalQuery(req.URL.Query()), canonHeaders.String(), signed, payload,
	}, "\n")
	scope := day + "/" + s.Region + "/s3/aws4_request"
	h := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(h[:])
	key := mac([]byte("AWS4"+s.SecretKey), day)
	key = mac(key, s.Region)
	key = mac(key, "s3")
	key = mac(key, "aws4_request")
	sig := hex.EncodeToString(mac(key, toSign))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		s.AccessKey, scope, signed, sig))
}

func mac(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vs := append([]string(nil), q[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, uriEncode(k, true)+"="+uriEncode(v, true))
		}
	}
	return strings.Join(parts, "&")
}

// escapePath URI-encodes each segment as SigV4 expects (unreserved characters kept, '/' kept).
func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = uriEncode(s, true)
	}
	return strings.Join(segs, "/")
}

func uriEncode(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func drain(res *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	_ = res.Body.Close()
}

func statusErr(op string, res *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	return fmt.Errorf("object store %s: status %d: %s", op, res.StatusCode, strings.TrimSpace(string(b)))
}
