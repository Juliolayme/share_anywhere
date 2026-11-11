// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateAdk } from './adk';
import {
  recoveryKeyMessage,
  recoveryKeySignature,
  rotationMessage,
  signWithAdk,
  verifyKeyOf,
  verifySignature,
  verifySignatureChain,
  type ChainState,
  type KeyVersionInfo,
} from './authenticity';
import { prepareKeySetup, recoverWithPhrase, type RecoveryResponse } from './bootstrap';
import { getOrCreateDeviceKey, proveDeviceKey } from './device-key';
import { b64uDecode, b64uEncode, utf8 } from './encoding';
import { acceptPairing, createPairingKeys, wrapForPairing } from './pairing';
import { acceptPendingBlobs, importChain, prepareRotation } from './rotation';
import { openKeyStore, type KeyStore } from './store';
import { wrapAdk, wrapChain } from './wrap';
import { generateX25519, type X25519KeyPair } from './x25519';

/**
 * Key authenticity rules (contract A.6, docs/CLIPBOARD_PROTOCOL.md §1) and the QA P0-1 attacks: an added device that
 * knows only the password (or a dishonest server) tries to slip its own ADK into the account.
 */
interface Device {
  id: string;
  store: KeyStore;
  key: X25519KeyPair;
}

const ID = {
  A: '00000000-0000-4000-8000-0000000000a1',
  B: '00000000-0000-4000-8000-0000000000b1',
  X: '00000000-0000-4000-8000-0000000000ee',
} as const;

async function device(id: string): Promise<Device> {
  const store = await openKeyStore({ factory: new IDBFactory() });
  return { id, store, key: (await getOrCreateDeviceKey(store)).keyPair };
}

async function registration(d: Device) {
  const reg = await proveDeviceKey(d.store, d.id, d.key);
  if (!reg) throw new Error('no ADK on the device');
  return { device_id: d.id, ...reg };
}

/** An account set up on A (v1), with B holding v1 too, and the server's view of it. */
async function account() {
  const a = await device(ID.A);
  const setup = await prepareKeySetup(a.store, { worker: false });
  await setup.commit();
  const b = await device(ID.B);
  const raw = await a.store.unwrapAdkRaw(1);
  await b.store.saveAdk(1, raw);
  const versions: KeyVersionInfo[] = [{ key_version: 1, verify_key: setup.request.verify_key, signature: null }];
  const recovery: RecoveryResponse = {
    key_version: 1,
    recovery_blob: setup.request.recovery_blob,
    salt: setup.request.salt,
    params: setup.request.params,
    recovery_anchor: setup.request.recovery_anchor,
  };
  const recoveryKey = {
    public_key: setup.request.recovery_public_key,
    signature: setup.request.recovery_key_signature,
  };
  return { a, b, setup, versions, recovery, recoveryKey, chain: [] as { key_version: number; blob: string }[] };
}

/**
 * The attacker's rotation: an ADK it chose, a chain link it made itself (it cannot wrap the real ADK(1), so it
 * wraps random bytes), and its own verify key published as version 2.
 */
async function forgedRotation(victimPublicKey: Uint8Array, recoveryPublicKey: Uint8Array) {
  const evil = generateAdk(2);
  const link = await wrapChain(evil.raw, generateAdk(1).raw, 2);
  const verifyKey = await verifyKeyOf(evil.raw);
  return {
    evil,
    pending: {
      key_version: 2,
      blob: b64uEncode(await wrapAdk(evil.raw, victimPublicKey, 'rotate', 2)),
      from_device_id: ID.X,
    },
    recoveryBlob: b64uEncode(await wrapAdk(evil.raw, recoveryPublicKey, 'recovery', 2)),
    link: { key_version: 2, blob: b64uEncode(link) },
    version: { key_version: 2, verify_key: b64uEncode(verifyKey), signature: b64uEncode(new Uint8Array(64).fill(7)) },
  };
}

let acct: Awaited<ReturnType<typeof account>>;
beforeAll(async () => {
  acct = await account();
}, 60_000);

describe('rotation pickup (acceptPendingBlobs)', () => {
  it('stores a genuine rotation: chain link leads to the held key and the verify key matches', async () => {
    const { a, b, setup, versions } = acct;
    // A copy of B with the same device key, so the shared B keeps holding only v1 for the other tests.
    const copy = { store: await openKeyStore({ factory: new IDBFactory() }), key: b.key };
    await copy.store.saveAdk(1, await b.store.unwrapAdkRaw(1));
    const rot = await prepareRotation(a.store, {
      serverKeyVersion: 1,
      recoveryPublicKey: setup.request.recovery_public_key,
      recoverySignature: setup.request.recovery_key_signature,
      devices: [await registration(a), await registration(b)],
    });
    // The request carries verify_key(2) and a signature by version 1 over the A.3 message.
    const vk1 = b64uDecode(setup.request.verify_key);
    const message = utf8(rotationMessage(2, b64uDecode(rot.request.verify_key), b64uDecode(rot.request.chain_blob)));
    expect(verifySignature(b64uDecode(rot.request.signature), message, vk1)).toBe(true);
    const blob = rot.request.device_blobs.find((d) => d.device_id === ID.B)?.blob ?? '';
    const state: ChainState = {
      chain: [{ key_version: 2, blob: rot.request.chain_blob }],
      versions: [...versions, { key_version: 2, verify_key: rot.request.verify_key, signature: rot.request.signature }],
    };
    // Same blob, wrong verify key published for v2: rejected.
    const wrongVk = {
      ...state,
      versions: [
        ...versions,
        { key_version: 2, verify_key: setup.request.verify_key, signature: rot.request.signature },
      ],
    };
    const pending = [{ key_version: 2, blob, from_device_id: ID.A }];
    expect(await acceptPendingBlobs(copy.store, copy.key, pending, wrongVk)).toEqual({
      accepted: [],
      failed: [{ key_version: 2, code: 'unverified' }],
    });
    expect(await copy.store.hasAdk(2)).toBe(false);
    expect(await acceptPendingBlobs(copy.store, copy.key, pending, state)).toEqual({
      accepted: [2],
      failed: [],
    });
    rot.discard();
  }, 30_000);

  it('rejects a forged blob from an attacker ADK with a self-made chain link (QA P0-1): nothing stored', async () => {
    const victim = await device(ID.B);
    await victim.store.saveAdk(1, await acct.a.store.unwrapAdkRaw(1));
    const forged = await forgedRotation(victim.key.publicKey, b64uDecode(acct.setup.request.recovery_public_key));
    // The server even lists the attacker's verify key for v2: the chain link still betrays it.
    const state: ChainState = { chain: [forged.link], versions: [...acct.versions, forged.version] };
    const res = await acceptPendingBlobs(victim.store, victim.key, [forged.pending], state);
    expect(res).toEqual({ accepted: [], failed: [{ key_version: 2, code: 'unverified' }] });
    expect(await victim.store.allVersions()).toEqual([1]);
    // No chain link at all is no better.
    expect(
      await acceptPendingBlobs(victim.store, victim.key, [forged.pending], { chain: [], versions: state.versions }),
    ).toEqual({ accepted: [], failed: [{ key_version: 2, code: 'unverified' }] });
  });

  it('refuses a rotation when the device lacks the version before it', async () => {
    const empty = await device(ID.B);
    const forged = await forgedRotation(empty.key.publicKey, b64uDecode(acct.setup.request.recovery_public_key));
    const res = await acceptPendingBlobs(empty.store, empty.key, [forged.pending], {
      chain: [forged.link],
      versions: [...acct.versions, forged.version],
    });
    expect(res).toEqual({ accepted: [], failed: [{ key_version: 2, code: 'not_found' }] });
    expect(await empty.store.currentVersion()).toBe(0);
  });
});

describe('rotating (prepareRotation)', () => {
  it('wraps only to devices whose proof verifies with its own copy of the proving version', async () => {
    const { a, b, setup } = acct;
    const good = await registration(b);
    // A device that only knows the password: its own ADK proves its key, which A cannot verify.
    const attacker = await device(ID.X);
    await attacker.store.saveAdk(1, generateAdk(1).raw);
    const selfProven = await registration(attacker);
    // B's real proof replayed for another device ID, and a proof claiming a version A does not hold.
    const replayed = { ...good, device_id: ID.X };
    const future = { ...good, key_version: 9 };
    const rot = await prepareRotation(a.store, {
      serverKeyVersion: 1,
      recoveryPublicKey: setup.request.recovery_public_key,
      recoverySignature: setup.request.recovery_key_signature,
      devices: [good, selfProven, { ...replayed }, future, { device_id: ID.A, public_key: null }],
    });
    expect(rot.request.device_blobs.map((d) => d.device_id)).toEqual([ID.B]);
    expect(rot.skipped).toEqual([
      { device_id: ID.X, reason: 'unproven' },
      { device_id: ID.X, reason: 'unproven' },
      { device_id: ID.B, reason: 'unproven' },
      { device_id: ID.A, reason: 'no_key' },
    ]);
    rot.discard();
  });
});

describe('recovery (recoverWithPhrase)', () => {
  it('recovers when anchor, signature chain and verify key all check out', async () => {
    const c = await device(ID.B);
    const v = await recoverWithPhrase(
      c.store,
      acct.setup.phrase,
      acct.recovery,
      { chain: [], versions: acct.versions },
      acct.recoveryKey,
      {
        worker: false,
      },
    );
    expect(v).toBe(1);
  }, 30_000);

  it('refuses a forged recovery blob for an attacker rotation (unsigned by v1): nothing stored', async () => {
    const c = await device(ID.B);
    const forged = await forgedRotation(c.key.publicKey, b64uDecode(acct.setup.request.recovery_public_key));
    const response = { ...acct.recovery, key_version: 2, recovery_blob: forged.recoveryBlob };
    await expect(
      recoverWithPhrase(
        c.store,
        acct.setup.phrase,
        response,
        { chain: [forged.link], versions: [...acct.versions, forged.version] },
        acct.recoveryKey,
        {
          worker: false,
        },
      ),
    ).rejects.toMatchObject({ code: 'recovery_unverified' });
    expect(await c.store.currentVersion()).toBe(0);
  }, 30_000);

  it('refuses a substituted v1 (attacker blob and verify key) because the anchor does not match', async () => {
    const c = await device(ID.B);
    const evil = generateAdk(1);
    const response = {
      ...acct.recovery,
      recovery_blob: b64uEncode(
        await wrapAdk(evil.raw, b64uDecode(acct.setup.request.recovery_public_key), 'recovery', 1),
      ),
    };
    const versions = [{ key_version: 1, verify_key: b64uEncode(await verifyKeyOf(evil.raw)), signature: null }];
    await expect(
      recoverWithPhrase(c.store, acct.setup.phrase, response, { chain: [], versions }, acct.recoveryKey, {
        worker: false,
      }),
    ).rejects.toMatchObject({ code: 'recovery_unverified' });
    expect(await c.store.currentVersion()).toBe(0);
  }, 30_000);

  it('refuses a tampered anchor, and a legacy account without one', async () => {
    const c = await device(ID.B);
    const anchor = b64uDecode(acct.recovery.recovery_anchor ?? '');
    anchor[0] = (anchor[0] ?? 0) ^ 1;
    const state = { chain: [], versions: acct.versions };
    await expect(
      recoverWithPhrase(
        c.store,
        acct.setup.phrase,
        { ...acct.recovery, recovery_anchor: b64uEncode(anchor) },
        state,
        acct.recoveryKey,
        { worker: false },
      ),
    ).rejects.toMatchObject({ code: 'recovery_unverified' });
    await expect(
      recoverWithPhrase(
        c.store,
        acct.setup.phrase,
        { ...acct.recovery, recovery_anchor: null },
        state,
        acct.recoveryKey,
        {
          worker: false,
        },
      ),
    ).rejects.toMatchObject({ code: 'keys_legacy' });
    expect(await c.store.currentVersion()).toBe(0);
  }, 60_000);
});

describe('signature chain and pairing receive', () => {
  it('a tampered rotation signature or chain link breaks the chain', async () => {
    const { a, setup, versions } = acct;
    const rot = await prepareRotation(a.store, {
      serverKeyVersion: 1,
      recoveryPublicKey: setup.request.recovery_public_key,
      recoverySignature: setup.request.recovery_key_signature,
      devices: [],
    });
    const v2 = { key_version: 2, verify_key: rot.request.verify_key, signature: rot.request.signature };
    const chain = [{ key_version: 2, blob: rot.request.chain_blob }];
    expect(() => verifySignatureChain({ chain, versions: [...versions, v2] }, 2)).not.toThrow();
    const sig = b64uDecode(rot.request.signature);
    sig[10] = (sig[10] ?? 0) ^ 0x40;
    expect(() =>
      verifySignatureChain({ chain, versions: [...versions, { ...v2, signature: b64uEncode(sig) }] }, 2),
    ).toThrow(expect.objectContaining({ code: 'unverified' }));
    const otherLink = b64uEncode(await wrapChain(generateAdk(2).raw, generateAdk(1).raw, 2));
    expect(() =>
      verifySignatureChain({ chain: [{ key_version: 2, blob: otherLink }], versions: [...versions, v2] }, 2),
    ).toThrow(expect.objectContaining({ code: 'unverified' }));
    expect(() => verifySignatureChain({ chain, versions: [...versions, { ...v2, signature: null }] }, 2)).toThrow(
      expect.objectContaining({ code: 'keys_legacy' }),
    );
    // A signature made by the new version itself (not by v1) is refused.
    const raw2 = generateAdk(2).raw;
    const vk2 = await verifyKeyOf(raw2);
    const selfSigned = await signWithAdk(raw2, utf8(rotationMessage(2, vk2, b64uDecode(rot.request.chain_blob))));
    expect(() =>
      verifySignatureChain(
        {
          chain,
          versions: [...versions, { key_version: 2, verify_key: b64uEncode(vk2), signature: b64uEncode(selfSigned) }],
        },
        2,
      ),
    ).toThrow(expect.objectContaining({ code: 'unverified' }));
    rot.discard();
  });

  it('pairing stores the key only when it matches the account verify key', async () => {
    const { a, versions } = acct;
    const pairing = await createPairingKeys();
    const { pairingFingerprint } = await import('./pairing');
    const fp = pairingFingerprint(pairing.ephemeralPublicKey);
    const wrapped = await wrapForPairing(a.store, a.key, pairing.ephemeralPublicKey, fp);
    const n = await device(ID.B);
    // A server presenting another verify key for v1 (a key that is not the account's): refused.
    const other = [{ key_version: 1, verify_key: b64uEncode(await verifyKeyOf(generateAdk(1).raw)), signature: null }];
    await expect(acceptPairing(n.store, pairing, wrapped, { chain: [], versions: other })).rejects.toMatchObject({
      code: 'unverified',
    });
    await expect(acceptPairing(n.store, pairing, wrapped, { chain: [], versions: [] })).rejects.toMatchObject({
      code: 'unverified',
    });
    expect(await n.store.currentVersion()).toBe(0);
    expect(await acceptPairing(n.store, pairing, wrapped, { chain: [], versions })).toBe(1);
  });
});

describe('authenticated recovery key (contract H, QA round 3 P0-1)', () => {
  it('setup signs the recovery public key with ADK v1 (H.1)', () => {
    const { setup } = acct;
    const message = utf8(recoveryKeyMessage(b64uDecode(setup.request.recovery_public_key)));
    const sig = b64uDecode(setup.request.recovery_key_signature);
    expect(verifySignature(sig, message, b64uDecode(setup.request.verify_key))).toBe(true);
    expect(message.length).toBeGreaterThan(0);
  });

  it('prepareRotation refuses a recovery key its own ADK v1 did not sign: nothing to send (H.3)', async () => {
    const { a, setup } = acct;
    const attacker = await generateX25519();
    const attackerKey = b64uEncode(attacker.publicKey);
    for (const recoverySignature of [
      undefined,
      'not base64!',
      setup.request.recovery_key_signature, // the genuine signature replayed for the attacker's key
      b64uEncode(await recoveryKeySignature(generateAdk(1).raw, attacker.publicKey)), // signed by another ADK
    ]) {
      await expect(
        prepareRotation(a.store, {
          serverKeyVersion: 1,
          recoveryPublicKey: attackerKey,
          recoverySignature,
          devices: [],
        }),
      ).rejects.toMatchObject({ code: 'unverified' });
    }
    await expect(
      prepareRotation(a.store, {
        serverKeyVersion: 1,
        recoveryPublicKey: setup.request.recovery_public_key,
        recoverySignature: null,
        devices: [],
      }),
    ).rejects.toMatchObject({ code: 'keys_legacy' });
    expect(await a.store.currentVersion()).toBe(1);
  });

  it('prepareRotation needs ADK v1 to check the signature (H.3)', async () => {
    const lone = await device(ID.X);
    await lone.store.saveAdk(2, generateAdk(2).raw);
    await expect(
      prepareRotation(lone.store, {
        serverKeyVersion: 2,
        recoveryPublicKey: acct.setup.request.recovery_public_key,
        recoverySignature: acct.setup.request.recovery_key_signature,
        devices: [],
      }),
    ).rejects.toMatchObject({ code: 'unverified' });
  });

  it('recovery refuses a mismatched or unsigned recovery key (H.4)', async () => {
    const c = await device(ID.B);
    const state = { chain: [], versions: acct.versions };
    const other = b64uEncode((await generateX25519()).publicKey);
    const opts = { worker: false };
    // The account lists another key than the phrase derives (even with a valid-looking signature for it).
    await expect(
      recoverWithPhrase(
        c.store,
        acct.setup.phrase,
        acct.recovery,
        state,
        { ...acct.recoveryKey, public_key: other },
        opts,
      ),
    ).rejects.toMatchObject({ code: 'recovery_unverified' });
    await expect(recoverWithPhrase(c.store, acct.setup.phrase, acct.recovery, state, null, opts)).rejects.toMatchObject(
      {
        code: 'recovery_unverified',
      },
    );
    // The phrase's key, but the signature is missing, tampered, or legacy (null).
    const sig = b64uDecode(acct.recoveryKey.signature);
    sig[3] = (sig[3] ?? 0) ^ 1;
    for (const signature of [undefined, b64uEncode(sig)]) {
      await expect(
        recoverWithPhrase(c.store, acct.setup.phrase, acct.recovery, state, { ...acct.recoveryKey, signature }, opts),
      ).rejects.toMatchObject({ code: 'recovery_unverified' });
    }
    await expect(
      recoverWithPhrase(
        c.store,
        acct.setup.phrase,
        acct.recovery,
        state,
        { ...acct.recoveryKey, signature: null },
        opts,
      ),
    ).rejects.toMatchObject({ code: 'keys_legacy' });
    expect(await c.store.currentVersion()).toBe(0);
  }, 120_000);
});

describe('importChain verifies the older versions it stores (contract I.6)', () => {
  it('stores ADK(v-1) only when it matches versions[v-1] and signed version v over the link', async () => {
    const { a, setup, versions } = acct;
    const owner = { store: await openKeyStore({ factory: new IDBFactory() }) };
    const adk1 = await a.store.unwrapAdkRaw(1);
    await owner.store.saveAdk(1, adk1);
    const rot = await prepareRotation(owner.store, {
      serverKeyVersion: 1,
      recoveryPublicKey: setup.request.recovery_public_key,
      recoverySignature: setup.request.recovery_key_signature,
      devices: [],
    });
    await rot.commit();
    const adk2 = await owner.store.unwrapAdkRaw(2);
    const v2 = { key_version: 2, verify_key: rot.request.verify_key, signature: rot.request.signature };
    const chain = [{ key_version: 2, blob: rot.request.chain_blob }];
    const fresh = async () => {
      const s = await openKeyStore({ factory: new IDBFactory() });
      await s.saveAdk(2, adk2);
      return s;
    };
    // Another verify key listed for v1: refused, nothing stored.
    const wrongV1 = [
      { key_version: 1, verify_key: b64uEncode(await verifyKeyOf(generateAdk(1).raw)), signature: null },
    ];
    let s = await fresh();
    await expect(importChain(s, { chain, versions: [...wrongV1, v2] })).rejects.toMatchObject({ code: 'unverified' });
    expect(await s.allVersions()).toEqual([2]);
    // A tampered signature on v2: refused; a legacy (null) one: keys_legacy.
    const sig = b64uDecode(rot.request.signature);
    sig[0] = (sig[0] ?? 0) ^ 1;
    s = await fresh();
    await expect(
      importChain(s, { chain, versions: [...versions, { ...v2, signature: b64uEncode(sig) }] }),
    ).rejects.toMatchObject({ code: 'unverified' });
    await expect(importChain(s, { chain, versions: [...versions, { ...v2, signature: null }] })).rejects.toMatchObject({
      code: 'keys_legacy',
    });
    expect(await s.allVersions()).toEqual([2]);
    // The genuine list: v1 stored.
    expect(await importChain(s, { chain, versions: [...versions, v2] })).toEqual([1]);
    expect(await s.unwrapAdkRaw(1)).toEqual(adk1);
  }, 30_000);
});
