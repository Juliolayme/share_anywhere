import type { components } from './schema.gen';
import { ApiError, NetworkError, toApiError } from './errors';
import { solvePow } from './pow';

type Schemas = components['schemas'];
export type Device = Schemas['Device'];
type DeviceSession = Schemas['DeviceSession'];
type PowRequired = Schemas['PowRequired'];

export interface DeviceClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Serializes refreshes across tabs so two tabs never present the same refresh cookie at once. */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  platform?: string;
  solve?: typeof solvePow;
}

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60_000;
const MIN_DELAY_MS = 5_000;

function browserLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request('sa-device-refresh', fn) as Promise<T>) : fn();
}

/** "Web · Firefox" style platform label from the user agent; the server cleans and limits it. */
export function platformLabel(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /(Chrome|CriOS)\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `Web · ${browser}`;
}

/**
 * Anonymous device identity for the Web (docs/ADR/0008-device-token-format.md): the access token lives
 * only in memory, the refresh secret only in the HttpOnly `sa_device` cookie. Refreshes are single-flight,
 * scheduled before expiry, and retried once on `401 device_token_expired`.
 */
export class DeviceClient {
  private token: string | null = null;
  private expiresAt = 0;
  private timer: unknown = null;
  private inflight: Promise<DeviceSession> | null = null;
  private listeners = new Set<(d: Device | null) => void>();
  device: Device | null = null;
  /** server_time − local time, for countdowns that must follow the server clock. */
  serverOffsetMs = 0;

  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly platform: string;
  private readonly solve: typeof solvePow;

  constructor(opts: DeviceClientOptions = {}) {
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.withLock = opts.withLock ?? browserLock;
    this.platform = opts.platform ?? platformLabel();
    this.solve = opts.solve ?? solvePow;
  }

  subscribe(fn: (d: Device | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setDevice(d: Device | null) {
    this.device = d;
    for (const fn of this.listeners) fn(d);
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.f(path, { credentials: 'same-origin', ...init });
    } catch (e) {
      throw new NetworkError(e);
    }
  }

  private accept(s: DeviceSession): DeviceSession {
    this.token = s.access_token;
    this.expiresAt = this.now() + s.expires_in * 1000;
    const server = Date.parse(s.server_time);
    if (Number.isFinite(server)) this.serverOffsetMs = server - this.now();
    this.setDevice(s.device);
    this.schedule(s.expires_in * 1000);
    return s;
  }

  private schedule(lifetimeMs: number) {
    if (this.timer !== null) this.clearTimer(this.timer);
    const delay = Math.max(MIN_DELAY_MS, lifetimeMs - REFRESH_MARGIN_MS);
    this.timer = this.setTimer(() => {
      this.timer = null;
      // A failed background refresh is retried on the next request that needs a token.
      this.refresh().catch(() => undefined);
    }, delay);
  }

  /** Restores the identity from the refresh cookie, or creates a new anonymous device. */
  async bootstrap(): Promise<Device> {
    try {
      await this.refresh();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      await this.create();
    }
    if (!this.device) throw new Error('device missing after bootstrap');
    return this.device;
  }

  /** Creates an anonymous device, solving a proof-of-work challenge when the server asks for one. */
  async create(signal?: AbortSignal): Promise<DeviceSession> {
    let pow: { token: string; solution: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.send('/v1/devices/anonymous', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: this.platform, transport: 'cookie', ...(pow ? { pow } : {}) }),
        ...(signal ? { signal } : {}),
      });
      if (res.ok) return this.accept((await res.json()) as DeviceSession);
      const err = await toApiError(res);
      if (err.status !== 428) throw err;
      const { challenge } = err.body as PowRequired;
      pow = { token: challenge.token, solution: await this.solve(challenge.token, challenge.difficulty, signal) };
    }
    throw new ApiError(428, 'pow_required', 'proof of work not accepted');
  }

  /** Rotates the refresh cookie and gets a new access token. Concurrent callers share one request. */
  refresh(): Promise<DeviceSession> {
    if (!this.inflight) {
      this.inflight = this.withLock(async () => {
        const res = await this.send('/v1/devices/token', { method: 'POST', headers: { 'X-SA-Refresh': '1' } });
        if (!res.ok) {
          const err = await toApiError(res);
          if (err.status === 401) {
            this.token = null;
            this.setDevice(null);
          }
          throw err;
        }
        return this.accept((await res.json()) as DeviceSession);
      }).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async accessToken(): Promise<string> {
    if (!this.token || this.now() >= this.expiresAt - 5_000) await this.refresh();
    if (!this.token) throw new ApiError(401, 'device_token_invalid', 'no device token');
    return this.token;
  }

  /** Authenticated JSON request; refreshes and retries once when the token expired or was rejected. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.send(path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) return (await res.json()) as T;
      const err = await toApiError(res);
      if (err.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      throw err;
    }
  }

  async rename(displayName: string): Promise<Device> {
    const d = await this.request<Device>('PATCH', '/v1/devices/current', { display_name: displayName });
    this.setDevice(d);
    return d;
  }

  /** Replaces this device with a new anonymous identity (the server revokes the old one). */
  async reset(): Promise<Device> {
    const s = await this.request<DeviceSession>('POST', '/v1/devices/current/reset', { transport: 'cookie' });
    return this.accept(s).device;
  }

  dispose() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
