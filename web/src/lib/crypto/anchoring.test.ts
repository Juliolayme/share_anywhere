// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { generateAdk } from './adk';
import {
  deviceKeyProof,
  recoveryKeySignature,
  rotationMessage,
  signWithAdk,
  verifyKeyOf,
  type ChainState,
} from './authenticity';
import { b64uEncode, utf8 } from './encoding';
import { acceptPairing, createPairingKeys, pairingFingerprint, wrapForPairing } from './pairing';
import { prepareRotation } from './rotation';
import { openKeyStore, type KeyStore } from './store';
import { getOrCreateDeviceKey } from './device-key';
import { wrapAdk, wrapChain } from './wrap';
import { generateX25519 } from './x25519';

/**
 * QA round 2 (contract D.3, F.1): proofs must be by the current version, and a device that already holds an ADK
 * anchors any account the server presents on the keys it holds. The first test of each block is the QA reviewer's
 * scratch proof turned around: the attack now fails.
 */
const ID = {
  A: '00000000-0000-4000-8000-0000000000a1',
  B: '00000000-0000-4000-8000-0000000000b1',
  C: '00000000-0000-4000-8000-0000000000c1',
  THIEF: '11111111-2222-4333-8444-555555555555',
} as const;

const rnd = () => crypto.getRandomValues(new Uint8Array(32));
const store = () => openKeyStore({ factory: new IDBFactory() });

/** A recovery key signed by ADK v1 (contract H.1), as `GET /v1/keys` lists it for a genuine account. */
async function recoveryFor(adk1: Uint8Array) {
  const pub = (await generateX25519()).publicKey;
  return { recoveryPublicKey: b64uEncode(pub), recoverySignature: b64uEncode(await recoveryKeySignature(adk1, pub)) };
}

/** A genuine account at v2: v1 set up, then rotated by a holder of v1. Returns the owner store and the server view. */
async function accountAtV2() {
  const owner = await store();
  const adk1 = generateAdk(1);
  await owner.saveAdk(1, adk1.raw);
  const rot = await prepareRotation(owner, {
    serverKeyVersion: 1,
    ...(await recoveryFor(adk1.raw)),
    devices: [],
  });
  await rot.commit();
  const chain: ChainState = {
    chain: [{ key_version: 2, blob: rot.request.chain_blob }],
    versions: [
      { key_version: 1, verify_key: b64uEncode(await verifyKeyOf(adk1.raw)), signature: null },
      { key_version: 2, verify_key: rot.request.verify_key, signature: rot.request.signature },
    ],
  };
  return { owner, adk1, chain };
}

async function pairFrom(sender: KeyStore, keyVersion?: number) {
  const pairing = await createPairingKeys();
  const { keyPair } = await getOrCreateDeviceKey(sender);
  const fp = pairingFingerprint(pairing.ephemeralPublicKey);
  const ready = await wrapForPairing(sender, keyPair, pairing.ephemeralPublicKey, fp, keyVersion);
  return { pairing, ready };
}

describe('prepareRotation wraps only to proofs by the current version (D.3)', () => {
  it('QA2 P1-A: at v2 a device proven only with the old v1 key (a revoked holder) gets nothing', async () => {
    const s = await store();
    const adk1 = rnd();
    await s.saveAdk(1, adk1);
    await s.saveAdk(2, rnd());
    const thief = await generateX25519();
    const reg = await deviceKeyProof(adk1, 1, ID.THIEF, thief.publicKey);
    const prep = await prepareRotation(s, {
      serverKeyVersion: 2,
      ...(await recoveryFor(adk1)),
      devices: [{ device_id: ID.THIEF, ...reg }],
    });
    expect(prep.skipped).toEqual([{ device_id: ID.THIEF, reason: 'stale' }]);
    expect(prep.request.device_blobs).toEqual([]);
    prep.discard();
  });

  it('wraps to current-version proofs, skips stale and excluded devices (any ID case), keeps no_key/unproven', async () => {
    const s = await store();
    const adk1 = rnd();
    const adk2 = rnd();
    await s.saveAdk(1, adk1);
    await s.saveAdk(2, adk2);
    const key = async () => (await generateX25519()).publicKey;
    const b = { device_id: ID.B, ...(await deviceKeyProof(adk2, 2, ID.B, await key())) };
    const c = { device_id: ID.C, ...(await deviceKeyProof(adk1, 1, ID.C, await key())) };
    const revoked = { device_id: ID.A, ...(await deviceKeyProof(adk2, 2, ID.A, await key())) };
    const forged = { device_id: ID.THIEF, ...(await deviceKeyProof(rnd(), 2, ID.THIEF, await key())) };
    const prep = await prepareRotation(s, {
      serverKeyVersion: 2,
      ...(await recoveryFor(adk1)),
      devices: [b, c, revoked, forged, { device_id: ID.C, public_key: null, key_version: null, proof: null }],
      exclude: [ID.A.toUpperCase()],
    });
    expect(prep.request.device_blobs.map((d) => d.device_id)).toEqual([ID.B]);
    expect(prep.skipped).toEqual([
      { device_id: ID.C, reason: 'stale' },
      { device_id: ID.A, reason: 'excluded' },
      { device_id: ID.THIEF, reason: 'unproven' },
      { device_id: ID.C, reason: 'no_key' },
    ]);
    prep.discard();
  });
});

describe('acceptPairing is anchored on the keys the device holds (F.1)', () => {
  it('QA2 P1-B: a device holding ADK v1 refuses a fabricated v1/v2 list and a server-owned pairing blob', async () => {
    const s = await store();
    const realAdk1 = rnd();
    await s.saveAdk(1, realAdk1);
    // A dishonest server fabricates versions 1..2 of its own and a sender device key of its own.
    const f1 = rnd();
    const f2 = rnd();
    const chain2 = await wrapChain(f2, f1, 2);
    const vk1 = await verifyKeyOf(f1);
    const vk2 = await verifyKeyOf(f2);
    const sig2 = await signWithAdk(f1, utf8(rotationMessage(2, vk2, chain2)));
    const chain: ChainState = {
      chain: [{ key_version: 2, blob: b64uEncode(chain2) }],
      versions: [
        { key_version: 1, verify_key: b64uEncode(vk1), signature: null },
        { key_version: 2, verify_key: b64uEncode(vk2), signature: b64uEncode(sig2) },
      ],
    };
    const pairing = await createPairingKeys();
    const serverSender = await generateX25519();
    const blob = await wrapAdk(f2, pairing.keyPair.publicKey, 'pair', 2, { senderKey: serverSender });
    const sender = b64uEncode(serverSender.publicKey);
    await expect(
      acceptPairing(s, pairing, { key_version: 2, sender_public_key: sender, blob: b64uEncode(blob) }, chain, {
        trustedSenderKeys: [sender],
      }),
    ).rejects.toMatchObject({ code: 'unverified' });
    expect(await s.allVersions()).toEqual([1]);
    expect(await s.unwrapAdkRaw(1)).toEqual(realAdk1);
  });

  it('a genuine-looking account that does not match the held v1 is refused', async () => {
    const { owner, chain } = await accountAtV2();
    const s = await store();
    await s.saveAdk(1, rnd()); // the v1 this device holds is not the one the server presents
    const { pairing, ready } = await pairFrom(owner);
    await expect(acceptPairing(s, pairing, ready, chain)).rejects.toMatchObject({ code: 'unverified' });
    expect(await s.allVersions()).toEqual([1]);
  });

  it('a device left behind at v1 pairs again to the genuine v2 (chain walk to the held ADK v1)', async () => {
    const { owner, adk1, chain } = await accountAtV2();
    const s = await store();
    await s.saveAdk(1, adk1.raw);
    const { pairing, ready } = await pairFrom(owner);
    expect(await acceptPairing(s, pairing, ready, chain)).toBe(2);
    expect(await s.allVersions()).toEqual([1, 2]);
  });

  it('refuses a roll-back to an older version than the one held', async () => {
    const { owner, chain } = await accountAtV2();
    const s = await store();
    await s.saveAdk(1, await owner.unwrapAdkRaw(1));
    await s.saveAdk(2, await owner.unwrapAdkRaw(2));
    const { pairing, ready } = await pairFrom(owner, 1);
    await expect(acceptPairing(s, pairing, ready, chain)).rejects.toMatchObject({ code: 'unverified' });
  });

  it('refuses a server that swaps the verify key of a version below the held one', async () => {
    const { owner, adk1, chain } = await accountAtV2();
    const s = await store();
    await s.saveAdk(1, adk1.raw);
    const swapped: ChainState = {
      ...chain,
      versions: chain.versions.map((v) =>
        v.key_version === 1 ? { ...v, verify_key: b64uEncode(new Uint8Array(32).fill(9)) } : v,
      ),
    };
    const { pairing, ready } = await pairFrom(owner);
    await expect(acceptPairing(s, pairing, ready, swapped)).rejects.toMatchObject({ code: 'unverified' });
    expect(await s.allVersions()).toEqual([1]);
  });

  it('at the held version itself the received key must be the held key', async () => {
    const { owner, chain } = await accountAtV2();
    const s = await store();
    await s.saveAdk(2, await owner.unwrapAdkRaw(2));
    const { pairing, ready } = await pairFrom(owner);
    expect(await acceptPairing(s, pairing, ready, chain)).toBe(2);
  });
});
