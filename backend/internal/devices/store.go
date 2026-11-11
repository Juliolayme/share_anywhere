package devices

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Device is a stored device identity.
type Device struct {
	ID          string
	Kind        string
	DisplayName string
	Platform    string
	// Transport is how refresh secrets reach this device: "cookie" (Web) or "body" (native), fixed at creation.
	Transport  string
	Generation int
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time
	RevokedAt  *time.Time
}

// LifetimeFor is how long a device of this kind lives without use (docs/SECURITY_MODEL.md §4).
func LifetimeFor(kind string) time.Duration {
	if kind == "account" {
		return AccountLifetime
	}
	return AnonymousLifetime
}

// Active reports whether the device can still be used at now.
func (d Device) Active(now time.Time) bool { return d.RevokedAt == nil && now.Before(d.ExpiresAt) }

// Store errors.
var (
	ErrNotFound       = errors.New("device not found")
	ErrSecretUnknown  = errors.New("refresh secret unknown")
	ErrSecretReused   = errors.New("refresh secret reused")
	ErrDeviceInactive = errors.New("device revoked or expired")
)

// Store persists devices and refresh-secret hashes.
type Store interface {
	CreateDevice(ctx context.Context, d Device, secretHash []byte) error
	// SecretDevice returns the device that owns a refresh-secret hash (used or not), without changing anything.
	SecretDevice(ctx context.Context, secretHash []byte) (string, error)
	// RotateSecret consumes oldHash and stores newHash, extending the device's lifetime (LifetimeFor its kind).
	// A consumed hash presented again revokes the device.
	RotateSecret(ctx context.Context, oldHash, newHash []byte, now time.Time) (Device, error)
	GetDevice(ctx context.Context, id string) (Device, error)
	RenameDevice(ctx context.Context, id, name string, now time.Time) (Device, error)
	RevokeDevice(ctx context.Context, id string, now time.Time) error
	// PurgeInactive deletes anonymous devices unused since lastSeenBefore or revoked before revokedBefore.
	PurgeInactive(ctx context.Context, lastSeenBefore, revokedBefore time.Time) (int64, error)
}

// MemStore is an in-memory Store for tests and database-less development.
type MemStore struct {
	mu      sync.Mutex
	devices map[string]*Device
	secrets map[string]*memSecret
}

type memSecret struct {
	deviceID   string
	generation int
	used       bool
	usedAt     time.Time
	retired    bool
}

// inReuseGrace reports whether presenting an already-used secret is the grace case: it is the immediately
// previous secret (the chain moved exactly one step since), first used at most RefreshReuseGrace ago, it was
// not retired by an earlier grace rotation, and the device is still active. Everything else is reuse.
func inReuseGrace(usedAt time.Time, generation int, retired bool, d Device, now time.Time) bool {
	return !retired && generation == d.Generation-1 && !now.Before(usedAt) && now.Sub(usedAt) <= RefreshReuseGrace && d.Active(now)
}

// NewMemStore returns an empty in-memory store.
func NewMemStore() *MemStore {
	return &MemStore{devices: map[string]*Device{}, secrets: map[string]*memSecret{}}
}

func (m *MemStore) CreateDevice(_ context.Context, d Device, secretHash []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := d
	m.devices[d.ID] = &cp
	m.secrets[string(secretHash)] = &memSecret{deviceID: d.ID, generation: d.Generation}
	return nil
}

func (m *MemStore) SecretDevice(_ context.Context, secretHash []byte) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.secrets[string(secretHash)]; ok {
		return s.deviceID, nil
	}
	return "", ErrSecretUnknown
}

func (m *MemStore) RotateSecret(_ context.Context, oldHash, newHash []byte, now time.Time) (Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.secrets[string(oldHash)]
	if !ok {
		return Device{}, ErrSecretUnknown
	}
	d := m.devices[s.deviceID]
	if d == nil {
		return Device{}, ErrSecretUnknown
	}
	if s.used && inReuseGrace(s.usedAt, s.generation, s.retired, *d, now) {
		for _, v := range m.secrets {
			if v.deviceID == d.ID && v.generation == d.Generation && !v.used {
				v.used, v.usedAt, v.retired = true, now, true
			}
		}
		s.used = false
	}
	if s.used {
		t := now
		d.RevokedAt = &t
		for k, v := range m.secrets {
			if v.deviceID == d.ID {
				delete(m.secrets, k)
			}
		}
		return Device{}, ErrSecretReused
	}
	if !d.Active(now) {
		return Device{}, ErrDeviceInactive
	}
	if s.usedAt.IsZero() {
		s.usedAt = now
	}
	s.used = true
	d.Generation++
	d.LastSeenAt = now
	d.ExpiresAt = now.Add(LifetimeFor(d.Kind))
	m.secrets[string(newHash)] = &memSecret{deviceID: d.ID, generation: d.Generation}
	return *d, nil
}

func (m *MemStore) GetDevice(_ context.Context, id string) (Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.devices[id]
	if !ok {
		return Device{}, ErrNotFound
	}
	return *d, nil
}

func (m *MemStore) RenameDevice(_ context.Context, id, name string, now time.Time) (Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.devices[id]
	if !ok || !d.Active(now) {
		return Device{}, ErrNotFound
	}
	d.DisplayName = name
	d.LastSeenAt = now
	return *d, nil
}

func (m *MemStore) RevokeDevice(_ context.Context, id string, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.devices[id]
	if !ok {
		return ErrNotFound
	}
	if d.RevokedAt == nil {
		t := now
		d.RevokedAt = &t
	}
	for k, v := range m.secrets {
		if v.deviceID == id {
			delete(m.secrets, k)
		}
	}
	return nil
}

func (m *MemStore) PurgeInactive(_ context.Context, lastSeenBefore, revokedBefore time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for id, d := range m.devices {
		if d.Kind != "anonymous" {
			continue
		}
		if d.LastSeenAt.Before(lastSeenBefore) || (d.RevokedAt != nil && d.RevokedAt.Before(revokedBefore)) {
			delete(m.devices, id)
			for k, v := range m.secrets {
				if v.deviceID == id {
					delete(m.secrets, k)
				}
			}
			n++
		}
	}
	return n, nil
}
