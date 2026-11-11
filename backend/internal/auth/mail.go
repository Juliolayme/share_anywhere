package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/smtp"
	"strings"
	"sync"
	"time"
)

// Message is one outgoing email.
type Message struct {
	To      string
	Subject string
	Body    string
	// Link is the action link inside Body (the reset link); sinks that log never log it outside development.
	Link string
}

// Mailer delivers email (docs/ARCHITECTURE.md §3.3). Implementations: ConsoleMailer (development),
// SMTPMailer (mailpit in development, a real relay in production), MemoryMailer (test stacks).
type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// ConsoleMailer logs that a message was sent. It logs the link itself only when ShowLinks is true, which
// cmd/server sets only with SA_ENV=development; it never logs the recipient address.
type ConsoleMailer struct {
	Log       *slog.Logger
	ShowLinks bool
}

// Send implements Mailer.
func (c ConsoleMailer) Send(_ context.Context, m Message) error {
	if c.ShowLinks {
		c.Log.Info("mail (development console sink)", "subject", m.Subject, "link", m.Link)
	} else {
		c.Log.Warn("mail not delivered: no mail sink configured (set SA_MAIL_SINK=smtp)", "subject", m.Subject)
	}
	return nil
}

// SMTPMailer sends through an SMTP server such as mailpit. net/smtp upgrades with STARTTLS when the server
// offers it and only sends credentials over TLS or to localhost.
type SMTPMailer struct {
	Addr     string
	From     string
	Username string
	Password string
}

// Send implements Mailer.
func (s SMTPMailer) Send(ctx context.Context, m Message) error {
	if strings.ContainsAny(m.To, "\r\n") || strings.ContainsAny(m.Subject, "\r\n") {
		return errors.New("mail: header injection refused")
	}
	host, _, err := net.SplitHostPort(s.Addr)
	if err != nil {
		return fmt.Errorf("mail: %w", err)
	}
	var auth smtp.Auth
	if s.Username != "" {
		auth = smtp.PlainAuth("", s.Username, s.Password, host)
	}
	msg := "From: " + s.From + "\r\nTo: " + m.To + "\r\nSubject: " + m.Subject +
		"\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nDate: " +
		time.Now().UTC().Format(time.RFC1123Z) + "\r\n\r\n" + strings.ReplaceAll(m.Body, "\n", "\r\n")
	done := make(chan error, 1)
	go func() { done <- smtp.SendMail(s.Addr, auth, s.From, []string{m.To}, []byte(msg)) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// MemoryMailer keeps sent messages in memory. Test stacks (SA_ENV=test) expose the last message per recipient
// through the testhooks build so end-to-end specs can follow a reset link.
type MemoryMailer struct {
	mu   sync.Mutex
	last map[string]Message
	all  []Message
}

// NewMemoryMailer returns an empty in-memory sink.
func NewMemoryMailer() *MemoryMailer { return &MemoryMailer{last: map[string]Message{}} }

// Send implements Mailer.
func (m *MemoryMailer) Send(_ context.Context, msg Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.last[strings.ToLower(msg.To)] = msg
	m.all = append(m.all, msg)
	if len(m.all) > 1000 {
		m.all = m.all[len(m.all)-1000:]
	}
	return nil
}

// Last returns the most recent message sent to an address.
func (m *MemoryMailer) Last(to string) (Message, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.last[strings.ToLower(to)]
	return msg, ok
}

// Count returns how many messages were sent.
func (m *MemoryMailer) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.all)
}
