// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/errors';
import {
  b64uEncode,
  checkDeviceKeyProof,
  generateAdk,
  verifyKeyOf,
  type DeviceKeyRegistration,
} from '../../lib/crypto';
import { wrapAdk, wrapChain } from '../../lib/crypto/wrap';
import type { AccountApi, KeyChain, KeysState } from './api';
import { checkKeys, keyStore, syncMeta, wipeAccountData } from './keyFlow';

/**
 * Account key steps against a stand-in for the keys API (docs/CLIPBOARD_PROTOCOL.md §1 "Key authenticity", contract
 * A.6): registration only once the device holds the ADK, with a proof by its newest version; rotation pickup that
 * stores and acknowledges only verified keys; honest states for `keys_legacy` and `device_key_unproven`.
 */
const DEVICE = '00000000-0000-4000-8000-0000000000d1';
const USER = 'u-1';

const adk1 = generateAdk(1);

function fakeApi(over: Partial<{ state: KeysState; chain: KeyChain; register: (r: DeviceKeyRegistration) => void }>) {
  const calls = { register: [] as DeviceKeyRegistration[], ack: [] as number[], chain: 0 };
  let state: KeysState = over.state ?? { key_version: 1, recovery: null, devices: [], pending: [] };
  const api = {
    keys: vi.fn(async () => state),
    chain: vi.fn(async () => {
      calls.chain++;
      return over.chain ?? { chain: [], versions: [] };
    }),
    registerKey: vi.fn(async (r: DeviceKeyRegistration) => {
      over.register?.(r);
      calls.register.push(r);
      state = {
        ...state,
        devices: [{ device_id: DEVICE, public_key: r.public_key, key_version: r.key_version, proof: r.proof }],
      };
    }),
    ackPending: vi.fn(async (v: number) => {
      calls.ack.push(v);
    }),
  };
  return { api: api as unknown as AccountApi, calls, setState: (s: KeysState) => (state = s) };
}

async function versionsUpTo1(): Promise<KeyChain['versions']> {
  return [{ key_version: 1, verify_key: b64uEncode(await verifyKeyOf(adk1.raw)), signature: null }];
}

beforeEach(async () => {
  await wipeAccountData().catch(() => undefined);
});

describe('checkKeys', () => {
  it('does not register the device key while the device holds no ADK (right after Add this device)', async () => {
    const { api, calls } = fakeApi({});
    const res = await checkKeys(api, USER, DEVICE);
    expect(res.status).toBe('pair');
    expect(calls.register).toEqual([]);
    expect(await (await keyStore()).currentVersion()).toBe(0);
    expect(await syncMeta().owner()).toBe(USER);
  });

  it('registers once the device holds the ADK, with a proof by its newest version, and only once', async () => {
    await (await keyStore()).saveAdk(1, adk1.raw);
    const { api, calls } = fakeApi({});
    expect((await checkKeys(api, USER, DEVICE)).status).toBe('ready');
    expect(calls.register).toHaveLength(1);
    const reg = calls.register[0] as DeviceKeyRegistration;
    expect(reg.key_version).toBe(1);
    expect(checkDeviceKeyProof(await verifyKeyOf(adk1.raw), DEVICE, 1, reg.public_key, reg.proof)).toBe(true);
    await checkKeys(api, USER, DEVICE);
    expect(calls.register).toHaveLength(1);
  });

  it('refuses a forged rotation: not stored, not acknowledged, status rejected', async () => {
    const store = await keyStore();
    await store.saveAdk(1, adk1.raw);
    const { api: first } = fakeApi({});
    await checkKeys(first, USER, DEVICE); // creates and registers the device key
    const deviceKey = await store.loadDeviceKey();
    if (!deviceKey) throw new Error('no device key');
    // An added device that knows only the password posts its own ADK as version 2.
    const evil = generateAdk(2);
    const pending = [
      {
        key_version: 2,
        blob: b64uEncode(await wrapAdk(evil.raw, deviceKey.publicKey, 'rotate', 2)),
        from_device_id: 'x',
      },
    ];
    const chain: KeyChain = {
      chain: [{ key_version: 2, blob: b64uEncode(await wrapChain(evil.raw, generateAdk(1).raw, 2)) }],
      versions: [
        ...(await versionsUpTo1()),
        {
          key_version: 2,
          verify_key: b64uEncode(await verifyKeyOf(evil.raw)),
          signature: b64uEncode(new Uint8Array(64)),
        },
      ],
    };
    const { api, calls } = fakeApi({
      state: {
        key_version: 2,
        recovery: null,
        devices: [{ device_id: DEVICE, public_key: b64uEncode(deviceKey.publicKey), key_version: 1, proof: 'x' }],
        pending,
      },
      chain,
    });
    const res = await checkKeys(api, USER, DEVICE);
    expect(res.status).toBe('rejected');
    expect(calls.ack).toEqual([]);
    expect(await store.allVersions()).toEqual([1]);
  });

  it('stores and acknowledges a genuine rotation and reports the new version', async () => {
    const store = await keyStore();
    await store.saveAdk(1, adk1.raw);
    const { api: first } = fakeApi({});
    await checkKeys(first, USER, DEVICE);
    const deviceKey = await store.loadDeviceKey();
    if (!deviceKey) throw new Error('no device key');
    const adk2 = generateAdk(2);
    const link = await wrapChain(adk2.raw, adk1.raw, 2);
    const reg = (first.registerKey as unknown as { mock: { calls: [DeviceKeyRegistration][] } }).mock.calls[0]?.[0];
    const { api, calls } = fakeApi({
      state: {
        key_version: 2,
        recovery: null,
        devices: [
          { device_id: DEVICE, public_key: reg?.public_key ?? null, key_version: 1, proof: reg?.proof ?? null },
        ],
        pending: [
          {
            key_version: 2,
            blob: b64uEncode(await wrapAdk(adk2.raw, deviceKey.publicKey, 'rotate', 2)),
            from_device_id: 'a',
          },
        ],
      },
      chain: {
        chain: [{ key_version: 2, blob: b64uEncode(link) }],
        versions: [
          ...(await versionsUpTo1()),
          {
            key_version: 2,
            verify_key: b64uEncode(await verifyKeyOf(adk2.raw)),
            signature: b64uEncode(new Uint8Array(64)),
          },
        ],
      },
    });
    const res = await checkKeys(api, USER, DEVICE);
    expect(res.status).toBe('ready');
    expect(res.newVersions).toEqual([2]);
    expect(calls.ack).toEqual([2]);
    expect(calls.register).toEqual([]);
    expect(await store.unwrapAdkRaw(2)).toEqual(adk2.raw);
  });

  it('409 keys_legacy and 403 device_key_unproven on registration give honest states', async () => {
    await (await keyStore()).saveAdk(1, adk1.raw);
    const legacy = fakeApi({
      register: () => {
        throw new ApiError(409, 'keys_legacy', 'legacy');
      },
    });
    expect((await checkKeys(legacy.api, USER, DEVICE)).status).toBe('legacy');
    const unproven = fakeApi({
      register: () => {
        throw new ApiError(403, 'device_key_unproven', 'unproven');
      },
    });
    expect((await checkKeys(unproven.api, USER, DEVICE)).status).toBe('rejected');
    const down = fakeApi({
      register: () => {
        throw new ApiError(500, 'internal', 'boom');
      },
    });
    await expect(checkKeys(down.api, USER, DEVICE)).rejects.toMatchObject({ code: 'internal' });
  });
});
