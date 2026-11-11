package devices

import (
	"context"
	"testing"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
)

type fakeAccounts struct {
	state   map[string]AccountState
	touched map[string]int
}

func (f *fakeAccounts) AccountState(_ context.Context, id string) (AccountState, error) {
	return f.state[id], nil
}

func (f *fakeAccounts) Refreshed(_ context.Context, id, _ string) (AccountState, error) {
	f.touched[id]++
	return f.state[id], nil
}

// TestAccountClaims: refresh re-derives acct/dl from the account layer, and Verify refuses a token whose
// account claims no longer match the live account session (sign-out, revoke, password reset).
func TestAccountClaims(t *testing.T) {
	f := newFixture(t, nil)
	acc := &fakeAccounts{state: map[string]AccountState{}, touched: map[string]int{}}
	f.svc.SetAccounts(acc)
	s0, err := f.svc.Create(ctx, "a", CreateInput{Transport: TransportBody, Platform: "Android"})
	if err != nil {
		t.Fatal(err)
	}
	if id, _ := f.svc.Verify(ctx, s0.AccessToken); id.AccountID != "" {
		t.Fatal("a new device is a guest")
	}
	acc.state[s0.Device.ID] = AccountState{AccountID: "u1", Added: true}
	s1, err := f.svc.Refresh(ctx, s0.Secret)
	if err != nil || acc.touched[s0.Device.ID] != 1 {
		t.Fatalf("refresh: %v touched=%d", err, acc.touched[s0.Device.ID])
	}
	id, err := f.svc.Verify(ctx, s1.AccessToken)
	if err != nil || id.AccountID != "u1" || !id.DeviceAdded {
		t.Fatalf("claims: %+v %v", id, err)
	}
	tok, err := f.svc.Token(ctx, s0.Device.ID)
	if err != nil || tok.Secret != "" || !tok.Account.Added {
		t.Fatalf("Token: %+v %v", tok, err)
	}
	// The session ends: the old token stops working once the cache is forgotten (the account layer does so).
	acc.state[s0.Device.ID] = AccountState{}
	f.svc.Forget(s0.Device.ID)
	if _, err := f.svc.Verify(ctx, s1.AccessToken); err != access.ErrTokenInvalid {
		t.Fatalf("stale account token: %v", err)
	}
	// A dl=true token for a not-added session is refused; a dl=false token for an added one is fine.
	acc.state[s0.Device.ID] = AccountState{AccountID: "u1"}
	f.svc.Forget(s0.Device.ID)
	if _, err := f.svc.Verify(ctx, s1.AccessToken); err != access.ErrTokenInvalid {
		t.Fatalf("dl downgrade: %v", err)
	}
	notAdded, _ := f.tokens.IssueWith(s0.Device.ID, s1.Device.Generation, AccountState{AccountID: "u1"})
	acc.state[s0.Device.ID] = AccountState{AccountID: "u1", Added: true}
	f.svc.Forget(s0.Device.ID)
	if _, err := f.svc.Verify(ctx, notAdded); err != nil {
		t.Fatalf("less-privileged token: %v", err)
	}
	// Another account's claim is refused.
	other, _ := f.tokens.IssueWith(s0.Device.ID, s1.Device.Generation, AccountState{AccountID: "u2", Added: true})
	if _, err := f.svc.Verify(ctx, other); err != access.ErrTokenInvalid {
		t.Fatalf("other account: %v", err)
	}
}

func TestReplaceIssuesUnlinkedIdentity(t *testing.T) {
	f := newFixture(t, nil)
	var revoked []string
	f.svc.OnRevoke(func(id string) { revoked = append(revoked, id) })
	s0, _ := f.svc.Create(ctx, "a", CreateInput{Transport: TransportCookie, Platform: "Web"})
	s1, err := f.svc.Replace(ctx, s0.Device.ID)
	if err != nil || s1.Device.ID == s0.Device.ID || s1.Device.Transport != TransportCookie || s1.Secret == "" {
		t.Fatalf("replace: %+v %v", s1.Device, err)
	}
	if len(revoked) != 1 || revoked[0] != s0.Device.ID {
		t.Fatalf("revoked: %v", revoked)
	}
	if _, err := f.svc.Verify(ctx, s0.AccessToken); err == nil {
		t.Fatal("old identity must be revoked")
	}
}

func TestAccountDeviceLifetime(t *testing.T) {
	if LifetimeFor("account") != 90*24*time.Hour || LifetimeFor("anonymous") != 30*24*time.Hour {
		t.Fatal("lifetimes changed without docs/SECURITY_MODEL.md §4")
	}
}
