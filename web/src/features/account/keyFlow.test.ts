// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '../../lib/api/errors';
import {
  b64uEncode,
  checkDeviceKeyProof,
  generateAdk,
  generateX25519,
  verifyKeyOf,
  type DeviceKeyRegistration,
} from '../../lib/crypto';
import { wrapAdk, wrapChain } from '../../lib/crypto/wrap';
import type { AccountApi, KeyChain, KeysRotateRequest, KeysState } from './api';
import { keyErrorStatus } from './AccountContext';
import { checkKeys, keyStore, rotateKeys, rotationErrorStatus, syncMeta, wipeAccountData } from './keyFlow';

/**
 * Account key steps against a stand-in for the keys API (docs/CLIPBOARD_PROTOCOL.md §1 "Key authenticity", contract
 * A.6 and the round 2 addendum D–F): registration only once the device holds the ADK, re-proving with the newest
 * version, rotation pickup that stores and acknowledges only verified keys, owed rotations, no wipe on a server that
 * reports an older key, and honest states for `keys_legacy`, `rejected` and `refused`.
 */
const DEVICE = '00000000-0000-4000-8000-0000000000d1';
const OTHER = '00000000-0000-4000-8000-0000000000d2';
const USER = 'u-1';

const adk1 = generateAdk(1);
const recoveryPublicKey = b64uEncode((await generateX25519()).publicKey);
const recovery = { public_key: recoveryPublicKey, salt: 'AAAAAAAAAAAAAAAAAAAAAA', params: { m: 65536, t: 3, p: 1 } };

type Handler<T> = (arg: T, call: number) => void;

interface FakeOptions {
  state?: KeysState;
  chain?: KeyChain;
  register?: Handler<DeviceKeyRegistration>;
  rotate?: Handler<KeysRotateRequest>;
}

/** A small stand-in server: registration stores the proof, an accepted rotation bumps the version and clears due. */
function fakeApi(over: FakeOptions = {}) {
  const calls = {
    register: [] as DeviceKeyRegistration[],
    rotate: [] as KeysRotateRequest[],
    ack: [] as number[],
    chain: 0,
  };
  const attempts = { register: 0, rotate: 0 };
  let state: KeysState = over.state ?? {
    key_version: 1,
    recovery: null,
    devices: [],
    pending: [],
    rotation_due: false,
  };
  const others = () => state.devices.filter((d) => d.device_id !== DEVICE);
  const api = {
    keys: vi.fn(async () => state),
    chain: vi.fn(async () => {
      calls.chain++;
      return over.chain ?? { chain: [], versions: [] };
    }),
    registerKey: vi.fn(async (r: DeviceKeyRegistration) => {
      over.register?.(r, attempts.register++);
      calls.register.push(r);
      state = {
        ...state,
        devices: [
          ...others(),
          { device_id: DEVICE, public_key: r.public_key, key_version: r.key_version, proof: r.proof },
        ],
      };
    }),
    rotate: vi.fn(async (req: KeysRotateRequest) => {
      over.rotate?.(req, attempts.rotate++);
      calls.rotate.push(req);
      state = { ...state, key_version: req.key_version, rotation_due: false, pending: [] };
      return { key_version: req.key_version };
    }),
    ackPending: vi.fn(async (v: number) => {
      calls.ack.push(v);
    }),
  };
  return {
    api: api as unknown as AccountApi,
    calls,
    get state() {
      return state;
    },
    setState: (s: Partial<KeysState>) => (state = { ...state, ...s }),
  };
}

async function versionsUpTo1(): Promise<KeyChain['versions']> {
  return [{ key_version: 1, verify_key: b64uEncode(await verifyKeyOf(adk1.raw)), signature: null }];
}

/** This device holding ADK v1, registered with a v1 proof. */
async function readyAtV1() {
  const store = await keyStore();
  await store.saveAdk(1, adk1.raw);
  const fake = fakeApi({ state: { key_version: 1, recovery, devices: [], pending: [], rotation_due: false } });
  expect((await checkKeys(fake.api, USER, DEVICE)).status).toBe('ready');
  return { store, fake };
}

beforeEach(async () => {
  await wipeAccountData().catch(() => undefined);
});

describe('checkKeys', () => {
  it('does not register the device key while the device holds no ADK (right after Add this device)', async () => {
    const { api, calls } = fakeApi();
    const res = await checkKeys(api, USER, DEVICE);
    expect(res.status).toBe('pair');
    expect(calls.register).toEqual([]);
    expect(await (await keyStore()).currentVersion()).toBe(0);
    expect(await syncMeta().owner()).toBe(USER);
  });

  it('registers once the device holds the ADK, with a proof by its newest version, and only once', async () => {
    await (await keyStore()).saveAdk(1, adk1.raw);
    const { api, calls } = fakeApi();
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
    await checkKeys(fakeApi().api, USER, DEVICE); // creates and registers the device key
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
        rotation_due: false,
      },
      chain,
    });
    const res = await checkKeys(api, USER, DEVICE);
    expect(res.status).toBe('rejected');
    expect(calls.ack).toEqual([]);
    expect(calls.register).toEqual([]);
    expect(await store.allVersions()).toEqual([1]);
  });

  it('stores a genuine rotation, acknowledges it, and re-proves with the new version (D.4)', async () => {
    const { store, fake: first } = await readyAtV1();
    const deviceKey = await store.loadDeviceKey();
    if (!deviceKey) throw new Error('no device key');
    const reg = first.calls.register[0];
    const adk2 = generateAdk(2);
    const link = await wrapChain(adk2.raw, adk1.raw, 2);
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
        rotation_due: false,
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
    expect(await store.unwrapAdkRaw(2)).toEqual(adk2.raw);
    expect(calls.register.map((r) => r.key_version)).toEqual([2]);
    const proof = calls.register[0] as DeviceKeyRegistration;
    expect(checkDeviceKeyProof(await verifyKeyOf(adk2.raw), DEVICE, 2, proof.public_key, proof.proof)).toBe(true);
  });

  it('re-proves when its registration is older than the newest held version (no pending blob needed)', async () => {
    const { store, fake } = await readyAtV1();
    const adk2 = generateAdk(2);
    await store.saveAdk(2, adk2.raw); // stored by pairing, recovery or chain work
    fake.setState({ key_version: 2 });
    expect((await checkKeys(fake.api, USER, DEVICE)).status).toBe('ready');
    expect(fake.calls.register.map((r) => r.key_version)).toEqual([1, 2]);
  });

  it('409 key_version_conflict on registration refreshes and retries once; a second conflict is refused', async () => {
    await (await keyStore()).saveAdk(1, adk1.raw);
    const once = fakeApi({
      register: (_r, n) => {
        if (n === 0) throw new ApiError(409, 'key_version_conflict', 'conflict');
      },
    });
    const res = await checkKeys(once.api, USER, DEVICE);
    expect(res.status).toBe('ready');
    expect(once.api.registerKey).toHaveBeenCalledTimes(2);

    await wipeAccountData();
    await (await keyStore()).saveAdk(1, adk1.raw);
    const always = fakeApi({
      register: () => {
        throw new ApiError(409, 'key_version_conflict', 'conflict');
      },
    });
    expect((await checkKeys(always.api, USER, DEVICE)).status).toBe('refused');
    expect(always.api.registerKey).toHaveBeenCalledTimes(2);
  });

  it('409 keys_legacy gives legacy, 403 device_key_unproven gives refused (not rejected), others throw', async () => {
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
    expect((await checkKeys(unproven.api, USER, DEVICE)).status).toBe('refused');
    const down = fakeApi({
      register: () => {
        throw new ApiError(500, 'internal', 'boom');
      },
    });
    await expect(checkKeys(down.api, USER, DEVICE)).rejects.toMatchObject({ code: 'internal' });
  });

  it('never wipes held keys when the server reports key_version 0 or an older version (F.2): rejected, keys kept', async () => {
    const { store, fake } = await readyAtV1();
    fake.setState({ key_version: 0, devices: [] });
    const res = await checkKeys(fake.api, USER, DEVICE);
    expect(res.status).toBe('rejected');
    expect(await store.allVersions()).toEqual([1]);
    expect(await store.unwrapAdkRaw(1)).toEqual(adk1.raw);

    await store.saveAdk(2, generateAdk(2).raw);
    fake.setState({ key_version: 1 });
    expect((await checkKeys(fake.api, USER, DEVICE)).status).toBe('rejected');
    expect(await store.allVersions()).toEqual([1, 2]);
  });

  it('keys of another account owner are still wiped', async () => {
    const { store } = await readyAtV1();
    const fake = fakeApi({ state: { key_version: 0, recovery: null, devices: [], pending: [], rotation_due: false } });
    expect((await checkKeys(fake.api, 'u-2', DEVICE)).status).toBe('setup');
    expect(await store.allVersions()).toEqual([]);
  });
});

describe('owed rotation (rotation_due, E.3)', () => {
  it('a ready device rotates on the key check and wraps only to current-version proofs', async () => {
    const { store, fake } = await readyAtV1();
    const other = await generateX25519();
    const { deviceKeyProof } = await import('../../lib/crypto');
    const proof = await deviceKeyProof(adk1.raw, 1, OTHER, other.publicKey);
    fake.setState({ rotation_due: true, devices: [...fake.state.devices, { device_id: OTHER, ...proof }] });
    const res = await checkKeys(fake.api, USER, DEVICE);
    expect(res.status).toBe('ready');
    expect(res.keyVersion).toBe(2);
    expect(res.rotationOwed).toBe(false);
    expect(fake.calls.rotate).toHaveLength(1);
    expect(fake.calls.rotate[0]?.device_blobs.map((b) => b.device_id).sort()).toEqual([DEVICE, OTHER].sort());
    expect(await store.allVersions()).toEqual([1, 2]);
    expect(fake.calls.register.at(-1)?.key_version).toBe(2); // re-proved with the new key
  });

  it('a failed owed rotation stays owed (rotationOwed) and the next check tries again', async () => {
    const { store, fake } = await readyAtV1();
    let fail = true;
    const flaky = fakeApi({
      state: { ...fake.state, rotation_due: true },
      rotate: () => {
        if (fail) throw new NetworkError();
      },
    });
    const first = await checkKeys(flaky.api, USER, DEVICE);
    expect(first.status).toBe('ready');
    expect(first.rotationOwed).toBe(true);
    expect(await store.allVersions()).toEqual([1]);
    fail = false;
    const second = await checkKeys(flaky.api, USER, DEVICE);
    expect(second.rotationOwed).toBe(false);
    expect(second.keyVersion).toBe(2);
    expect(flaky.api.rotate).toHaveBeenCalledTimes(2);
  });

  it('devices_changed (missing / unexpected) refreshes the key state and retries once', async () => {
    const { fake } = await readyAtV1();
    const other = await generateX25519();
    const { deviceKeyProof } = await import('../../lib/crypto');
    const proof = await deviceKeyProof(adk1.raw, 1, OTHER, other.publicKey);
    const raced = fakeApi({
      state: { ...fake.state, devices: [...fake.state.devices, { device_id: OTHER, ...proof }] },
      rotate: (_req, n) => {
        if (n === 0) {
          // OTHER left meanwhile: the server lists its blob as unexpected and drops it from GET /v1/keys.
          raced.setState({ devices: raced.state.devices.filter((d) => d.device_id !== OTHER) });
          throw new ApiError(409, 'devices_changed', 'changed', undefined, {
            error: 'devices_changed',
            missing: [],
            unexpected: [OTHER],
          });
        }
      },
    });
    expect(await rotateKeys(raced.api, USER, DEVICE)).toBe('rotated');
    const sent = (raced.api.rotate as unknown as { mock: { calls: [KeysRotateRequest][] } }).mock.calls;
    expect(sent.map(([r]) => r.device_blobs.map((b) => b.device_id).sort())).toEqual([
      [DEVICE, OTHER].sort(),
      [DEVICE],
    ]);

    const stuck = fakeApi({
      state: { ...raced.state },
      rotate: () => {
        throw new ApiError(409, 'devices_changed', 'changed', undefined, { missing: [OTHER], unexpected: [] });
      },
    });
    await expect(rotateKeys(stuck.api, USER, DEVICE)).rejects.toMatchObject({ code: 'devices_changed' });
    expect(stuck.api.rotate).toHaveBeenCalledTimes(2);
  });

  it('an owed rotation that loses the race to another device does not rotate again', async () => {
    const { fake } = await readyAtV1();
    const raced = fakeApi({
      state: { ...fake.state, rotation_due: true },
      rotate: () => {
        // Another ready device rotated first and cleared rotation_due; this device was not proven at v1 by it.
        raced.setState({ key_version: 2, rotation_due: false });
        throw new ApiError(409, 'key_version_conflict', 'conflict');
      },
    });
    const res = await checkKeys(raced.api, USER, DEVICE);
    expect(raced.api.rotate).toHaveBeenCalledTimes(1);
    expect(res.rotationOwed).toBe(false);
    expect(res.status).toBe('pair'); // it waits for its blob or pairs again; nothing is reported as owed
  });

  it('rotateKeys never wraps to an excluded (just revoked) device', async () => {
    const { fake } = await readyAtV1();
    const other = await generateX25519();
    const { deviceKeyProof } = await import('../../lib/crypto');
    const proof = await deviceKeyProof(adk1.raw, 1, OTHER, other.publicKey);
    fake.setState({ devices: [...fake.state.devices, { device_id: OTHER, ...proof }] });
    expect(await rotateKeys(fake.api, USER, DEVICE, [OTHER])).toBe('rotated');
    expect(fake.calls.rotate[0]?.device_blobs.map((b) => b.device_id)).toEqual([DEVICE]);
  });

  it('the server refusing this device’s own rotation gives refused, not rejected (F.3)', async () => {
    const { fake } = await readyAtV1();
    const refusing = fakeApi({
      state: { ...fake.state, rotation_due: true },
      rotate: () => {
        throw new ApiError(403, 'rotation_unauthorized', 'nope');
      },
    });
    const res = await checkKeys(refusing.api, USER, DEVICE);
    expect(res.status).toBe('refused');
    expect(res.rotationOwed).toBe(false);
  });
});

describe('refused vs rejected mapping (F.3)', () => {
  it('maps this device’s own refusals to refused and incoming unverified keys to rejected', () => {
    for (const code of ['rotation_unauthorized', 'device_key_unproven', 'key_version_conflict']) {
      expect(rotationErrorStatus(new ApiError(409, code, code))).toBe('refused');
      expect(keyErrorStatus(new ApiError(409, code, code))).toBe('refused');
    }
    expect(keyErrorStatus({ code: 'unverified' })).toBe('rejected');
    expect(rotationErrorStatus(new ApiError(409, 'keys_legacy', 'legacy'))).toBe('legacy');
    expect(rotationErrorStatus(new NetworkError())).toBeNull();
    expect(rotationErrorStatus(new ApiError(409, 'devices_changed', 'changed'))).toBeNull();
  });
});
