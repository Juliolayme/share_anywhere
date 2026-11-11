// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ChainState, KeyVersionInfo } from './authenticity';
import { prepareKeySetup, recoverWithPhrase } from './bootstrap';
import { getOrCreateDeviceKey, proveDeviceKey, publicKeyB64 } from './device-key';
import { decryptItemText, encryptItem, type EncryptedItem } from './item';
import {
  acceptPairing,
  createPairingKeys,
  pairingFingerprint,
  pairingPayload,
  parsePairingPayload,
  wrapForPairing,
} from './pairing';
import { acceptPendingBlobs, importChain, prepareRotation, type ChainLink, type PendingBlob } from './rotation';
import { openKeyStore, type KeyStore } from './store';
import type { X25519KeyPair } from './x25519';

/**
 * End-to-end key flows over an in-memory stand-in for the keys API (contract §Keys): setup on device A,
 * pairing to B, recovery on C, rotation after revoking C, chain import. Only opaque blobs cross "the server".
 */
interface Device {
  id: string;
  store: KeyStore;
  key: X25519KeyPair;
}

const ID = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
  D: '00000000-0000-4000-8000-00000000000d',
  E: '00000000-0000-4000-8000-00000000000e',
} as const;

/** The device's `GET /v1/keys` devices[] row once it registered with a proof (contract A.4). */
async function registered(d: Device) {
  const reg = await proveDeviceKey(d.store, d.id, d.key);
  if (!reg) throw new Error('device holds no ADK');
  return { device_id: d.id, ...reg };
}

async function device(id: string): Promise<Device> {
  const store = await openKeyStore({ factory: new IDBFactory() });
  return { id, store, key: (await getOrCreateDeviceKey(store)).keyPair };
}

async function writeEntry(
  d: Device,
  id: string,
  text: string,
): Promise<{ id: string; v: number; item: EncryptedItem }> {
  const v = await d.store.currentVersion();
  return { id, v, item: await encryptItem(await d.store.loadSubkeys(v, 'history'), id, v, text) };
}

async function readEntry(d: Device, e: { id: string; v: number; item: EncryptedItem }): Promise<string> {
  return decryptItemText(await d.store.loadSubkeys(e.v, 'history'), e.id, e.v, e.item);
}

describe('account key flows', () => {
  it('setup → pairing → recovery → rotation keeps old entries readable and locks out the revoked device', async () => {
    const server = {
      keyVersion: 0,
      recovery: null as null | {
        public_key: string;
        salt: string;
        params: { m: number; t: number; p: number };
        blob: string;
        anchor: string;
        signature: string;
      },
      devices: new Map<string, Awaited<ReturnType<typeof registered>>>(),
      pending: new Map<string, PendingBlob[]>(),
      chain: [] as ChainLink[],
      versions: [] as KeyVersionInfo[],
    };
    const chainState = (): ChainState => ({ chain: server.chain, versions: server.versions });

    // Device A: first device sets up keys; it registers its device key only once it holds the ADK.
    const a = await device(ID.A);
    expect(await proveDeviceKey(a.store, a.id, a.key)).toBeNull();
    const setup = await prepareKeySetup(a.store, { worker: false });
    expect(setup.phrase.split(' ')).toHaveLength(12);
    expect(setup.request.params).toEqual({ m: 65536, t: 3, p: 1 });
    server.keyVersion = 1;
    server.recovery = {
      ...setup.request,
      public_key: setup.request.recovery_public_key,
      blob: setup.request.recovery_blob,
      anchor: setup.request.recovery_anchor,
      signature: setup.request.recovery_key_signature,
    };
    server.versions.push({ key_version: 1, verify_key: setup.request.verify_key, signature: null });
    await setup.commit();
    expect(await a.store.currentVersion()).toBe(1);
    server.devices.set(a.id, await registered(a));
    const old = await writeEntry(a, 'entry-1', 'written with v1');

    // Device B pairs with A through the QR payload.
    const b = await device(ID.B);
    const pairing = await createPairingKeys();
    const payload = pairingPayload('CODE123', pairing.ephemeralPublicKey);
    const scanned = parsePairingPayload(payload);
    expect(scanned?.code).toBe('CODE123');
    // A server that substitutes its own key for the code is caught by the fingerprint.
    const evil = await createPairingKeys();
    await expect(
      wrapForPairing(a.store, a.key, evil.ephemeralPublicKey, scanned?.fingerprint ?? ''),
    ).rejects.toMatchObject({
      code: 'untrusted_sender',
    });
    const wrapped = await wrapForPairing(a.store, a.key, pairing.ephemeralPublicKey, scanned?.fingerprint ?? '');
    expect(wrapped.sender_public_key).toBe(publicKeyB64(a.key));
    await expect(
      acceptPairing(b.store, pairing, wrapped, chainState(), { trustedSenderKeys: [publicKeyB64(b.key)] }),
    ).rejects.toMatchObject({ code: 'untrusted_sender' });
    const trusted = [...server.devices.values()].map((d) => d.public_key);
    expect(await acceptPairing(b.store, pairing, wrapped, chainState(), { trustedSenderKeys: trusted })).toBe(1);
    server.devices.set(b.id, await registered(b));
    expect(await readEntry(b, old)).toBe('written with v1');

    // Device C recovers with the phrase (a wrong phrase fails to decrypt, a malformed one fails validation).
    const c = await device(ID.C);
    const rec = server.recovery;
    if (!rec) throw new Error('no recovery');
    const response = {
      key_version: server.keyVersion,
      recovery_blob: rec.blob,
      salt: rec.salt,
      params: rec.params,
      recovery_anchor: rec.anchor,
    };
    const recoveryKey = { public_key: rec.public_key, signature: rec.signature };
    await expect(
      recoverWithPhrase(c.store, 'zoo zoo zoo', response, chainState(), recoveryKey, { worker: false }),
    ).rejects.toMatchObject({
      code: 'invalid_phrase',
    });
    await expect(
      recoverWithPhrase(
        c.store,
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
        response,
        chainState(),
        recoveryKey,
        { worker: false },
      ),
    ).rejects.toMatchObject({ code: 'decrypt_failed' });
    expect(
      await recoverWithPhrase(c.store, ` ${setup.phrase.toUpperCase()} `, response, chainState(), recoveryKey, {
        worker: false,
      }),
    ).toBe(1);
    server.devices.set(c.id, await registered(c));
    expect(await readEntry(c, old)).toBe('written with v1');

    // A revokes C and rotates: D registered a key without a valid proof, E registered none.
    server.devices.delete(c.id);
    const forgedProof = { ...(await registered(c)), device_id: ID.D };
    const rotation = await prepareRotation(a.store, {
      serverKeyVersion: server.keyVersion,
      recoveryPublicKey: rec.public_key,
      recoverySignature: rec.signature,
      devices: [
        ...server.devices.values(),
        forgedProof,
        { device_id: ID.E, public_key: null, key_version: null, proof: null },
      ],
    });
    expect(rotation.request.key_version).toBe(2);
    expect(rotation.skipped).toEqual([
      { device_id: ID.D, reason: 'unproven' },
      { device_id: ID.E, reason: 'no_key' },
    ]);
    expect(rotation.request.device_blobs.map((d) => d.device_id).sort()).toEqual([ID.A, ID.B]);
    server.keyVersion = 2;
    server.recovery = { ...rec, blob: rotation.request.recovery_blob };
    server.chain.push({ key_version: 2, blob: rotation.request.chain_blob });
    server.versions.push({
      key_version: 2,
      verify_key: rotation.request.verify_key,
      signature: rotation.request.signature,
    });
    for (const d of rotation.request.device_blobs) {
      server.pending.set(d.device_id, [{ key_version: 2, blob: d.blob, from_device_id: ID.A }]);
    }
    await rotation.commit();
    await expect(rotation.commit()).rejects.toThrow();
    expect(await a.store.currentVersion()).toBe(2);
    const fresh = await writeEntry(a, 'entry-2', 'written with v2');
    expect(fresh.v).toBe(2);

    // A's own pending blob is harmless (same bytes); B picks up v2 and reads old and new entries.
    expect(await acceptPendingBlobs(a.store, a.key, server.pending.get(ID.A) ?? [], chainState())).toEqual({
      accepted: [2],
      failed: [],
    });
    const resultB = await acceptPendingBlobs(b.store, b.key, server.pending.get(ID.B) ?? [], chainState());
    expect(resultB).toEqual({ accepted: [2], failed: [] });
    expect(await readEntry(b, fresh)).toBe('written with v2');
    expect(await readEntry(b, old)).toBe('written with v1');

    // C, revoked, cannot open B's blob or the new entry.
    const stolen = await acceptPendingBlobs(c.store, c.key, server.pending.get(ID.B) ?? [], chainState());
    expect(stolen).toEqual({ accepted: [], failed: [{ key_version: 2, code: 'decrypt_failed' }] });
    await expect(readEntry(c, fresh)).rejects.toMatchObject({ code: 'not_found' });

    // A new device E recovers v2 with the phrase (anchor + signature chain) and walks the chain back to v1.
    const e = await device(ID.E);
    const recovered = await recoverWithPhrase(
      e.store,
      setup.phrase,
      { ...response, key_version: 2, recovery_blob: rotation.request.recovery_blob },
      chainState(),
      recoveryKey,
      { worker: false },
    );
    expect(recovered).toBe(2);
    await expect(readEntry(e, old)).rejects.toMatchObject({ code: 'not_found' });
    expect(await importChain(e.store, chainState())).toEqual([1]);
    expect(await importChain(e.store, chainState())).toEqual([]);
    expect(await readEntry(e, old)).toBe('written with v1');
    expect(await readEntry(e, fresh)).toBe('written with v2');
  }, 90_000);

  it('rotation refuses to start when the device is behind the server', async () => {
    const a = await device(ID.A);
    await expect(
      prepareRotation(a.store, {
        serverKeyVersion: 1,
        recoveryPublicKey: publicKeyB64(a.key),
        recoverySignature: null,
        devices: [],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a discarded setup stores nothing', async () => {
    const a = await device(ID.A);
    const setup = await prepareKeySetup(a.store, { worker: false });
    setup.discard();
    expect(await a.store.currentVersion()).toBe(0);
    await expect(setup.commit()).rejects.toThrow();
  }, 30_000);

  it('pairing payloads parse strictly', async () => {
    const { ephemeralPublicKey } = await createPairingKeys();
    const fp = pairingFingerprint(ephemeralPublicKey);
    expect(parsePairingPayload(` sa1.abc.def.${fp} `)).toEqual({ code: 'abc.def', fingerprint: fp });
    for (const bad of ['', 'abc', `sa2.abc.${fp}`, 'sa1.abc.short', `sa1..${fp}`])
      expect(parsePairingPayload(bad)).toBeNull();
    expect(() => pairingPayload('has space', ephemeralPublicKey)).toThrow();
  });
});
