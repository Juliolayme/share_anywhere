package sharing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// Member is the calling device's place in a session, for packages that build on sessions (transfers).
type Member struct {
	SessionID     string
	SessionStatus string
	ParticipantID string
	Role          string // sender | receiver
	Status        string // participant status (the sender is always JOINED)
	SignedIn      bool
	// Capability is this receiver's transfer capability (docs/TRANSFER_PROTOCOL.md §3); empty for the sender
	// and for receivers that are not JOINED.
	Capability string
}

// Live reports whether the session still accepts transfer activity.
func (m Member) Live() bool {
	return m.SessionStatus == StatusWaiting || m.SessionStatus == StatusActive
}

// Peer is a receiver as the sender's transfer engine needs it.
type Peer struct {
	ParticipantID string `json:"participant_id"`
	Status        string `json:"status"`
	// CapabilityHash is hex SHA-256 of the receiver's transfer capability. The sender compares it with the
	// capability the receiver presents in HELLO; the sender never learns the capability itself.
	CapabilityHash string `json:"capability_hash,omitempty"`
}

// Member returns the caller's membership. Devices that are not participants get ErrNotFound (existence hidden).
func (s *Service) Member(ctx context.Context, deviceID, sessionID string) (Member, error) {
	return s.member(ctx, s.cfg.Pool, deviceID, sessionID)
}

// MemberTx is Member read inside tx. A caller holding locks in a transaction must use it rather than Member:
// taking a second pool connection while holding the session row lock can exhaust the pool while every other
// connection waits for that lock.
func (s *Service) MemberTx(ctx context.Context, tx pgx.Tx, deviceID, sessionID string) (Member, error) {
	return s.member(ctx, tx, deviceID, sessionID)
}

func (s *Service) member(ctx context.Context, q querier, deviceID, sessionID string) (Member, error) {
	if !ValidID(sessionID) {
		return Member{}, ErrNotFound
	}
	r, err := scanSession(q.QueryRow(ctx, `SELECT `+sessionCols+` FROM share_sessions WHERE id = $1::uuid`, sessionID))
	if err != nil {
		return Member{}, ErrNotFound
	}
	p, err := participantFor(ctx, q, sessionID, deviceID)
	if err != nil {
		return Member{}, ErrNotFound
	}
	m := Member{SessionID: sessionID, SessionStatus: r.Status, ParticipantID: p.ID, Role: p.Role, Status: p.Status, SignedIn: p.SignedIn}
	if p.Role == "receiver" && p.Status == PJoined && p.JoinedAt != nil {
		m.Capability = s.capability(p.ID, p.DeviceID, *p.JoinedAt)
	}
	return m, nil
}

// Peers lists the session's receivers with the hash of each JOINED receiver's transfer capability.
func (s *Service) Peers(ctx context.Context, sessionID string) ([]Peer, error) {
	rows, err := s.cfg.Pool.Query(ctx, `SELECT `+participantCols+` FROM session_participants
		WHERE session_id = $1::uuid AND role = 'receiver' ORDER BY created_at, id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Peer{}
	for rows.Next() {
		p, err := scanParticipant(rows)
		if err != nil {
			return nil, err
		}
		peer := Peer{ParticipantID: p.ID, Status: p.Status}
		if p.Status == PJoined && p.JoinedAt != nil {
			sum := sha256.Sum256([]byte(s.capability(p.ID, p.DeviceID, *p.JoinedAt)))
			peer.CapabilityHash = hex.EncodeToString(sum[:])
		}
		out = append(out, peer)
	}
	return out, rows.Err()
}

// capability derives a receiver's transfer capability: 256 bits bound to the participant, its device and the
// moment it joined, so a rejoin after Remove gets a new one and Remove or Block revokes it with the status.
func (s *Service) capability(participantID, deviceID string, joinedAt time.Time) string {
	m := hmac.New(sha256.New, s.keys.xfer)
	m.Write([]byte(participantID + "|" + deviceID + "|" + strconv.FormatInt(joinedAt.UTC().UnixMicro(), 10)))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
