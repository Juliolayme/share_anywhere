// Package httpx holds JSON helpers and the error format shared by every endpoint (docs/API.md §3).
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"time"
)

// ErrorBody is the JSON error format: {"error", "message", "retry_after_s"}.
type ErrorBody struct {
	Error       string `json:"error"`
	Message     string `json:"message"`
	RetryAfterS int    `json:"retry_after_s,omitempty"`
}

// JSON writes v with the given status.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes an error body.
func Error(w http.ResponseWriter, status int, code, message string) {
	JSON(w, status, ErrorBody{Error: code, Message: message})
}

// RetryAfterSeconds rounds a wait up to whole seconds (minimum 1).
func RetryAfterSeconds(wait time.Duration) int {
	return int(math.Max(1, math.Ceil(wait.Seconds())))
}

// RateLimited writes 429 with Retry-After.
func RateLimited(w http.ResponseWriter, code string, wait time.Duration) {
	s := RetryAfterSeconds(wait)
	w.Header().Set("Retry-After", strconv.Itoa(s))
	JSON(w, http.StatusTooManyRequests, ErrorBody{Error: code, Message: "Too many attempts. Try again later.", RetryAfterS: s})
}

// ErrBadBody is returned by Decode when the body is not valid JSON for the target.
var ErrBadBody = errors.New("bad request body")

// Decode reads a JSON body of at most maxBytes into v, rejecting unknown fields and trailing data.
// An empty body decodes to the zero value when allowEmpty is true.
func Decode(r *http.Request, v any, maxBytes int64, allowEmpty bool) error {
	body := http.MaxBytesReader(nil, r.Body, maxBytes)
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if allowEmpty && errors.Is(err, io.EOF) {
			return nil
		}
		return ErrBadBody
	}
	if dec.More() {
		return ErrBadBody
	}
	return nil
}

// BadRequest writes 400 invalid_request.
func BadRequest(w http.ResponseWriter, message string) {
	Error(w, http.StatusBadRequest, "invalid_request", message)
}
