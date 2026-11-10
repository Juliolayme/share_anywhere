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
