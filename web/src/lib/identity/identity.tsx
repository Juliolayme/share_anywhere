import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DeviceClient, type Device } from '../api/device-client';
import { ApiError, NetworkError } from '../api/errors';

export type IdentityStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'offline' }
  | { kind: 'rate_limited'; retryAt: number }
  | { kind: 'failed' };

interface IdentityValue {
  client: DeviceClient;
  device: Device | null;
  status: IdentityStatus;
  retry: () => void;
}

const IdentityContext = createContext<IdentityValue | null>(null);

/**
 * Creates or restores the anonymous device identity in the background (PRD §5.1). Navigation never waits
 * for it; screens that need it show the status inline.
 */
export function IdentityProvider({ children, client: given }: { children: ReactNode; client?: DeviceClient }) {
  const clientRef = useRef<DeviceClient>(given ?? new DeviceClient());
  const client = clientRef.current;
  const [device, setDevice] = useState<Device | null>(client.device);
  const [status, setStatus] = useState<IdentityStatus>({ kind: 'loading' });
  const running = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setStatus({ kind: 'loading' });
    try {
      await client.bootstrap();
      setStatus({ kind: 'ready' });
    } catch (e) {
      if (e instanceof NetworkError || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        setStatus({ kind: 'offline' });
      } else if (e instanceof ApiError && e.status === 429) {
        setStatus({ kind: 'rate_limited', retryAt: Date.now() + (e.retryAfterS ?? 60) * 1000 });
      } else {
        setStatus({ kind: 'failed' });
      }
    } finally {
      running.current = false;
    }
  }, [client]);

  useEffect(() => client.subscribe(setDevice), [client]);

  useEffect(() => {
    void run();
    const online = () => {
      if (statusRef.current.kind === 'offline') void run();
    };
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      client.dispose();
    };
  }, [client, run]);

  // A device revoked elsewhere (refresh reuse, reset in another tab) drops back to bootstrap.
  useEffect(() => {
    if (status.kind === 'ready' && device === null) void run();
  }, [device, status.kind, run]);

  const value = useMemo(() => ({ client, device, status, retry: () => void run() }), [client, device, status, run]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityValue {
  const v = useContext(IdentityContext);
  if (!v) throw new Error('useIdentity outside IdentityProvider');
  return v;
}

/** Seconds left until `at`, updated every second; 0 once passed. */
export function useCountdown(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [at]);
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}

export function formatWait(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
