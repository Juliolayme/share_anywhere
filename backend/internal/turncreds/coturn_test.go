package turncreds

import (
	"net"
	"os"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

// allocate performs a TURN Allocate against coturn with the given credentials.
func allocate(t *testing.T, addr, user, pass string) error {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	c, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: addr, TURNServerAddr: addr, Conn: conn,
		Username: user, Password: pass, Realm: "shareanywhere.local",
		RTO: 300 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Listen(); err != nil {
		t.Fatal(err)
	}
	relay, err := c.Allocate()
	if err != nil {
		return err
	}
	return relay.Close()
}

// TestCredentialsAgainstCoturn runs when TURN_TEST_ADDR points at the CI stack's coturn (docker-compose.ci.yml):
// issued credentials allocate a relay; a wrong secret and an expired credential are refused.
func TestCredentialsAgainstCoturn(t *testing.T) {
	addr := os.Getenv("TURN_TEST_ADDR")
	secret := os.Getenv("TURN_TEST_SECRET")
	if addr == "" || secret == "" {
		t.Skip("TURN_TEST_ADDR / TURN_TEST_SECRET not set")
	}
	user, cred := Sign([]byte(secret), "pid-ci", time.Now().Add(GuestTTL))
	if err := allocate(t, addr, user, cred); err != nil {
		t.Fatalf("valid credential must allocate: %v", err)
	}
	user, cred = Sign([]byte("wrong-secret"), "pid-ci", time.Now().Add(GuestTTL))
	if err := allocate(t, addr, user, cred); err == nil {
		t.Fatal("credential signed with another secret must be refused")
	}
	user, cred = Sign([]byte(secret), "pid-ci", time.Now().Add(-time.Minute))
	if err := allocate(t, addr, user, cred); err == nil {
		t.Fatal("expired credential must be refused")
	}
}
