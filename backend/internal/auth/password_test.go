package auth

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"
)

// TestArgon2Parameters pins the production cost (docs/ADR/0009-argon2id-passwords.md) and the PHC format.
func TestArgon2Parameters(t *testing.T) {
	p := DefaultArgon2
	if p.MemoryKiB < 19456 || p.Time < 2 || p.Threads != 1 || p.SaltLen < 16 || p.KeyLen != 32 {
		t.Fatalf("Argon2id parameters below the ADR baseline: %+v", p)
	}
	if p.MemoryKiB != 19456 || p.Time != 2 {
		t.Fatalf("parameters changed without updating ADR 0009 and this test: %+v", p)
	}
	h := NewHasher(p, 2)
	enc, err := h.Hash(context.Background(), "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(enc, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("unexpected encoding %q", enc)
	}
	other, _ := h.Hash(context.Background(), "correct horse battery")
	if other == enc {
		t.Fatal("salt must be random per hash")
	}
	if ok, rehash, err := h.Verify(context.Background(), enc, "correct horse battery"); !ok || rehash || err != nil {
		t.Fatalf("verify: %v %v %v", ok, rehash, err)
	}
	if ok, _, _ := h.Verify(context.Background(), enc, "correct horse batterY"); ok {
		t.Fatal("wrong password accepted")
	}
	// Unknown email: verified against the dummy hash, never matches.
	if ok, _, err := h.Verify(context.Background(), "", "correct horse battery"); ok || err != nil {
		t.Fatalf("unknown account: %v %v", ok, err)
	}
	// A hash made with weaker parameters still verifies and asks for an upgrade.
	weak := NewHasher(cheapArgon2, 1)
	old, _ := weak.Hash(context.Background(), "correct horse battery")
	if ok, rehash, _ := h.Verify(context.Background(), old, "correct horse battery"); !ok || !rehash {
		t.Fatalf("old parameters: ok=%v rehash=%v", ok, rehash)
	}
	for _, bad := range []string{"", "$argon2i$v=19$m=1,t=1,p=1$AA$AA", "$argon2id$v=19$m=19456,t=2,p=1$!!$!!", "plain"} {
		if bad == "" {
			continue
		}
		if _, _, err := h.Verify(context.Background(), bad, "x"); err == nil {
			t.Errorf("malformed hash %q accepted", bad)
		}
	}
}

func TestHasherBoundsConcurrency(t *testing.T) {
	h := NewHasher(cheapArgon2, 1)
	h.sem <- struct{}{} // occupy the only slot
	c, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := h.Hash(c, "correct horse battery"); err == nil {
		t.Fatal("hash must wait for a free slot and give up with the context")
	}
	<-h.sem
}

func TestCheckPassword(t *testing.T) {
	cases := map[string]bool{
		"short":                           false,
		"1234567890":                      false, // common
		"PASSWORD123":                     false, // common, case-insensitive
		"aaaaaaaaaaaa":                    false, // one repeated character
		"alice-is-great-2026":             false, // contains the email's local part
		strings.Repeat("x", 129):          false,
		"correct horse battery":           true,
		"Zw9!kq2#Lm":                      true,
		strings.Repeat("ab", 64):          true,
		"\xff\xfe invalid utf8 sequence!": false,
	}
	for pw, ok := range cases {
		if err := CheckPassword(pw, "alice@example.com"); (err == nil) != ok {
			t.Errorf("CheckPassword(%q) = %v, want ok=%v", pw, err, ok)
		}
	}
}

func TestNormalizeEmail(t *testing.T) {
	good := map[string]string{
		"Alice@Example.COM":     "alice@example.com",
		"  bob+tag@mail.co.uk ": "bob+tag@mail.co.uk",
	}
	for in, want := range good {
		if got, err := NormalizeEmail(in); err != nil || got != want {
			t.Errorf("NormalizeEmail(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "a@b", "no-at.example.com", "Alice <a@example.com>", "a@.example.com", "a@example.com.",
		"a b@example.com", "a@example.com\r\nBcc: x@y.z", strings.Repeat("a", 65) + "@example.com", "a@@example.com"} {
		if _, err := NormalizeEmail(bad); err == nil {
			t.Errorf("NormalizeEmail(%q) accepted", bad)
		}
	}
}

func TestConsoleMailerLogsLinkOnlyWhenAllowed(t *testing.T) {
	for _, show := range []bool{false, true} {
		var buf bytes.Buffer
		m := ConsoleMailer{Log: slog.New(slog.NewTextHandler(&buf, nil)), ShowLinks: show}
		_ = m.Send(context.Background(), Message{To: "alice@example.com", Subject: "Reset", Link: "https://app.example/reset?token=SECRET"})
		out := buf.String()
		if strings.Contains(out, "SECRET") != show {
			t.Errorf("ShowLinks=%v: log %q", show, out)
		}
		if strings.Contains(out, "alice@example.com") {
			t.Errorf("the recipient must never be logged: %q", out)
		}
	}
}

// TestSMTPMailer sends through a minimal in-process SMTP server (what mailpit speaks).
func TestSMTPMailer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	got := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		rd := bufio.NewReader(c)
		w := func(s string) { _, _ = c.Write([]byte(s + "\r\n")) }
		w("220 test ESMTP")
		var data strings.Builder
		inData := false
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				return
			}
			if inData {
				if line == ".\r\n" {
					inData = false
					w("250 OK")
					got <- data.String()
					continue
				}
				data.WriteString(line)
				continue
			}
			switch cmd := strings.ToUpper(strings.TrimSpace(line)); {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				w("250 test")
			case strings.HasPrefix(cmd, "DATA"):
				inData = true
				w("354 go ahead")
			case strings.HasPrefix(cmd, "QUIT"):
				w("221 bye")
				return
			default:
				w("250 OK")
			}
		}
	}()
	m := SMTPMailer{Addr: ln.Addr().String(), From: "Share Anywhere <no-reply@localhost>"}
	if err := m.Send(context.Background(), Message{To: "alice@example.com", Subject: "Reset", Body: "line1\nhttps://app.example/reset?token=abc"}); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-got:
		if !strings.Contains(msg, "Subject: Reset\r\n") || !strings.Contains(msg, "To: alice@example.com") || !strings.Contains(msg, "reset?token=abc") {
			t.Fatalf("message: %q", msg)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no message received")
	}
	if err := m.Send(context.Background(), Message{To: "a@example.com\r\nBcc: x@example.com", Subject: "x"}); err == nil {
		t.Fatal("header injection must be refused")
	}
}

func TestMemoryMailer(t *testing.T) {
	m := NewMemoryMailer()
	_ = m.Send(context.Background(), Message{To: "Alice@Example.com", Link: "l1"})
	_ = m.Send(context.Background(), Message{To: "alice@example.com", Link: "l2"})
	if last, ok := m.Last("ALICE@example.com"); !ok || last.Link != "l2" || m.Count() != 2 {
		t.Fatalf("last: %+v %v", last, ok)
	}
}

type failingMailer struct{}

func (failingMailer) Send(_ context.Context, m Message) error {
	return &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("550 mailbox " + m.To + " unavailable")}
}

// TestResetMailFailureLogsNoAddress (QA P2): a mail failure is logged with a fixed message and an error
// class, never the error text, which may quote the recipient.
func TestResetMailFailureLogsNoAddress(t *testing.T) {
	e := newEnv(t)
	e.signup("xia@example.com", true)
	var buf bytes.Buffer
	e.svc.cfg.Mailer = failingMailer{}
	e.svc.cfg.Log = slog.New(slog.NewTextHandler(&buf, nil))
	e.svc.sendReset("xia@example.com")
	out := buf.String()
	if !strings.Contains(out, "password reset mail failed") || !strings.Contains(out, "error_class=*net.OpError") || strings.Contains(out, "xia@") {
		t.Fatalf("log: %q", out)
	}
	if errClass(context.DeadlineExceeded) != "timeout" {
		t.Fatal("deadline is a timeout")
	}
}
