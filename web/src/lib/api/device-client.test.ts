import { describe, expect, it, vi } from 'vitest';
import { DeviceClient, platformLabel, REFRESH_MARGIN_MS } from './device-client';
import { ApiError, NetworkError } from './errors';
import { leadingZeroBits, solvePow } from './pow';

const device = (id = 'd1', name = 'Web · Chrome · Calm Otter') => ({
  id,
  kind: 'anonymous',
  display_name: name,
  platform: 'Web · Chrome',
  created_at: '2026-11-10T00:00:00Z',
  last_seen_at: '2026-11-10T00:00:00Z',
});
const session = (id = 'd1', token = 'tok-1') => ({
  device: device(id),
  access_token: token,
  expires_in: 900,
  server_time: '2026-11-10T00:00:00Z',
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

type Call = { url: string; init: RequestInit };

function harness(responses: ((c: Call) => Response)[]) {
  const calls: Call[] = [];
  let now = 1_000_000;
  const timers: { fn: () => void; ms: number }[] = [];
  const client = new DeviceClient({
    fetch: (async (url: string, init: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected call ${url}`);
      return next(c);
    }) as unknown as typeof fetch,
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
    withLock: (fn) => fn(),
    platform: 'Web · Test',
    solve: async () => 'solved',
  });
  return { client, calls, timers, advance: (ms: number) => (now += ms) };
}

describe('DeviceClient', () => {
  it('restores the identity from the refresh cookie with the CSRF header', async () => {
    const h = harness([() => json(200, session())]);
    const d = await h.client.bootstrap();
    expect(d.id).toBe('d1');
    expect(h.calls[0]?.url).toBe('/v1/devices/token');
    expect((h.calls[0]?.init.headers as Record<string, string>)['X-SA-Refresh']).toBe('1');
    expect(h.calls[0]?.init.credentials).toBe('same-origin');
  });

  it('creates an anonymous device with cookie transport when there is no cookie', async () => {
    const h = harness([() => json(401, { error: 'refresh_invalid' }), () => json(201, session('d2'))]);
    const d = await h.client.bootstrap();
    expect(d.id).toBe('d2');
    expect(JSON.parse(String(h.calls[1]?.init.body))).toEqual({ platform: 'Web · Test', transport: 'cookie' });
  });

  it('solves the proof-of-work challenge when the server requires one', async () => {
    const h = harness([
      () => json(428, { error: 'pow_required', challenge: { token: 'c1', difficulty: 8, expires_in: 300 } }),
      () => json(201, session()),
    ]);
    await h.client.create();
    expect(JSON.parse(String(h.calls[1]?.init.body)).pow).toEqual({ token: 'c1', solution: 'solved' });
  });

  it('surfaces 429 with the wait time and network failures as NetworkError', async () => {
    const h = harness([
      () => json(401, { error: 'refresh_invalid' }),
      () => json(429, { error: 'rate_limited', retry_after_s: 1800 }, { 'Retry-After': '1800' }),
    ]);
    const err = await h.client.bootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).retryAfterS).toBe(1800);

    const off = new DeviceClient({
      fetch: (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch,
      withLock: (fn) => fn(),
    });
    await expect(off.bootstrap()).rejects.toBeInstanceOf(NetworkError);
  });

  it('schedules the refresh one minute before expiry and refreshes when the timer fires', async () => {
    const h = harness([() => json(200, session('d1', 'a')), () => json(200, session('d1', 'b'))]);
    await h.client.bootstrap();
    expect(h.timers[0]?.ms).toBe(900_000 - REFRESH_MARGIN_MS);
    h.timers[0]?.fn();
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
  });

  it('shares one refresh between concurrent callers', async () => {
    const h = harness([() => json(200, session())]);
    await Promise.all([h.client.refresh(), h.client.refresh(), h.client.refresh()]);
    expect(h.calls).toHaveLength(1);
  });

  it('sends the bearer token and retries once after a 401 with a fresh token', async () => {
    const h = harness([
      () => json(200, session('d1', 'old')),
      () => json(401, { error: 'device_token_expired' }),
      () => json(200, session('d1', 'new')),
      (c) => json(200, { ...device(), display_name: JSON.parse(String(c.init.body)).display_name }),
    ]);
    await h.client.bootstrap();
    const d = await h.client.rename('Desk');
    expect(d.display_name).toBe('Desk');
    expect((h.calls[1]?.init.headers as Record<string, string>).Authorization).toBe('Bearer old');
    expect((h.calls[3]?.init.headers as Record<string, string>).Authorization).toBe('Bearer new');
    expect(h.client.device?.display_name).toBe('Desk');
  });

  it('refreshes before a request when the token is about to expire', async () => {
    const h = harness([
      () => json(200, session('d1', 'a')),
      () => json(200, session('d1', 'b')),
      () => json(200, device()),
    ]);
    await h.client.bootstrap();
    h.advance(899_000);
    await h.client.request('GET', '/v1/devices/current');
    expect(h.calls.map((c) => c.url)).toEqual(['/v1/devices/token', '/v1/devices/token', '/v1/devices/current']);
  });

  it('reset replaces the identity and notifies subscribers', async () => {
    const h = harness([() => json(200, session('d1')), () => json(201, session('d9', 'z'))]);
    const seen: (string | undefined)[] = [];
    h.client.subscribe((d) => seen.push(d?.id));
    await h.client.bootstrap();
    await h.client.reset();
    expect(seen).toEqual(['d1', 'd9']);
  });
});

const jwt = (payload: object) =>
  `h.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

describe('DeviceClient and account sessions', () => {
  it('does not refresh and resubmit on a 401 that is an answer (sign-in invalid_credentials)', async () => {
    const h = harness([() => json(200, session()), () => json(401, { error: 'invalid_credentials' })]);
    await h.client.bootstrap();
    const err = await h.client.request('POST', '/v1/auth/signin', { email: 'a@b.co', password: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('invalid_credentials');
    expect(h.calls.map((c) => c.url)).toEqual(['/v1/devices/token', '/v1/auth/signin']);
  });

  it('refreshes and retries once on device_token_invalid (token minted before the account session changed)', async () => {
    const h = harness([
      () => json(200, session('d1', jwt({ sub: 'd1', acct: 'u1', dl: true }))),
      () => json(401, { error: 'device_token_invalid' }),
      () => json(200, session('d1', jwt({ sub: 'd1' }))),
      () => json(200, { ok: true }),
    ]);
    const seen: (string | undefined)[] = [];
    h.client.subscribeClaims((c) => seen.push(c?.acct ?? 'guest'));
    await h.client.bootstrap();
    await h.client.request('GET', '/v1/me');
    expect(h.calls.map((c) => c.url)).toEqual(['/v1/devices/token', '/v1/me', '/v1/devices/token', '/v1/me']);
    // The account session ended elsewhere: the next token is a guest token and listeners hear it.
    expect(seen).toEqual(['u1', 'guest']);
    expect(h.client.claims).toEqual({ sub: 'd1' });
  });

  it('takes a new access token for the same device (sign-in, add device) without touching the device', async () => {
    const h = harness([() => json(200, session('d1', jwt({ sub: 'd1' }))), () => json(200, { a: 1 })]);
    const devices: (string | undefined)[] = [];
    const claims: unknown[] = [];
    h.client.subscribe((d) => devices.push(d?.id));
    h.client.subscribeClaims((c) => claims.push(c));
    await h.client.bootstrap();
    const signedIn = jwt({ sub: 'd1', acct: 'u1' });
    h.client.acceptToken({ access_token: signedIn, expires_in: 900 });
    expect(h.client.device?.id).toBe('d1');
    expect(h.client.claims).toEqual({ sub: 'd1', acct: 'u1' });
    h.client.acceptToken({ access_token: jwt({ sub: 'd1', acct: 'u1', dl: true }), expires_in: 900 });
    await h.client.request('GET', '/v1/devices');
    expect((h.calls[1]?.init.headers as Record<string, string>).Authorization).toContain('Bearer h.');
    expect(devices).toEqual(['d1']);
    expect(claims).toEqual([{ sub: 'd1' }, { sub: 'd1', acct: 'u1' }, { sub: 'd1', acct: 'u1', dl: true }]);
  });

  it('takes the fresh anonymous identity from sign-out (new device ID)', async () => {
    const h = harness([() => json(200, session('d1', jwt({ sub: 'd1', acct: 'u1', dl: true })))]);
    await h.client.bootstrap();
    h.client.acceptSession(session('d2', jwt({ sub: 'd2' })) as Parameters<typeof h.client.acceptSession>[0]);
    expect(h.client.device?.id).toBe('d2');
    expect(h.client.claims).toEqual({ sub: 'd2' });
  });

  it('resolves bodiless answers (202, 204) to undefined and sends public requests without a token', async () => {
    const h = harness([
      () => json(200, session()),
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 202 }),
    ]);
    await h.client.bootstrap();
    expect(await h.client.request('DELETE', '/v1/history')).toBeUndefined();
    expect(
      await h.client.publicRequest('POST', '/v1/auth/password-reset/request', { email: 'a@b.co' }),
    ).toBeUndefined();
    expect((h.calls[2]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('platform label and proof-of-work', () => {
  it('names the browser', () => {
    expect(platformLabel('Mozilla/5.0 (X11) Gecko/20100101 Firefox/130.0')).toBe('Web · Firefox');
    expect(platformLabel('Mozilla/5.0 AppleWebKit/605 Version/17 Safari/605')).toBe('Web · Safari');
    expect(platformLabel('Mozilla/5.0 Chrome/130 Safari/537 Edg/130')).toBe('Web · Edge');
    expect(platformLabel('Mozilla/5.0 Chrome/130 Safari/537')).toBe('Web · Chrome');
  });

  it('counts leading zero bits and finds a valid solution', async () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x10]))).toBe(11);
    const sol = await solvePow('token', 6);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`token:${sol}`)));
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(6);
  });
});
