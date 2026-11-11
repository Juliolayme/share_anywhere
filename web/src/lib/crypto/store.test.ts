// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveSubkey, generateAdk } from './adk';
import { getOrCreateDeviceKey } from './device-key';
import { KeyStoreUnavailableError } from './errors';
import { hex } from './encoding';
import { decryptItemText, encryptItem } from './item';
import { KEY_DB_NAME, openKeyStore } from './store';
import { forceX25519Backend, generateX25519 } from './x25519';

afterEach(() => forceX25519Backend(null));

async function readKek(factory: IDBFactory): Promise<CryptoKey> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(KEY_DB_NAME);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const key = await new Promise<CryptoKey>((resolve, reject) => {
    const r = db.transaction('meta').objectStore('meta').get('kek');
    r.onsuccess = () => resolve(r.result as CryptoKey);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return key;
}

describe('IndexedDB key store', () => {
  it('starts empty and keeps ADK versions across a re-open', async () => {
    const factory = new IDBFactory();
    const adk1 = generateAdk(1);
    const adk2 = generateAdk(2);
    let store = await openKeyStore({ factory });
    expect(await store.currentVersion()).toBe(0);
    expect(await store.allVersions()).toEqual([]);
    await store.saveAdk(2, adk2.raw);
    await store.saveAdk(1, adk1.raw);
    const enc = await encryptItem(await store.loadSubkeys(2, 'history'), 'e1', 2, 'kept');
    store.close();

    store = await openKeyStore({ factory });
    expect(await store.allVersions()).toEqual([1, 2]);
    expect(await store.currentVersion()).toBe(2);
    expect(await decryptItemText(await store.loadSubkeys(2, 'history'), 'e1', 2, enc)).toBe('kept');
    expect(hex(await store.unwrapAdkRaw(1))).toBe(hex(adk1.raw));
    // The stored subkey matches one derived from the raw ADK.
    const direct = await encryptItem(await deriveSubkey(adk2.raw, 'clipboard'), 'c1', 2, 'same key');
    expect(await decryptItemText(await store.loadSubkeys(2, 'clipboard'), 'c1', 2, direct)).toBe('same key');
    await expect(store.loadSubkeys(3, 'history')).rejects.toMatchObject({ code: 'not_found' });
    store.close();
  });

  it('keeps the KEK, the subkeys, and the device private key non-extractable', async () => {
    const factory = new IDBFactory();
    const store = await openKeyStore({ factory });
    await store.saveAdk(1, generateAdk().raw);
    const subkey = await store.loadSubkeys(1, 'history');
    expect(subkey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', subkey)).rejects.toThrow();
    const kek = await readKek(factory);
    expect(kek.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', kek)).rejects.toThrow();
    const { keyPair, created } = await getOrCreateDeviceKey(store);
    expect(created).toBe(true);
    store.close();

    const again = await openKeyStore({ factory });
    const loaded = await getOrCreateDeviceKey(again);
    expect(loaded.created).toBe(false);
    expect(hex(loaded.keyPair.publicKey)).toBe(hex(keyPair.publicKey));
    if (loaded.keyPair.privateKey.kind !== 'webcrypto') throw new Error('expected the WebCrypto backend in Node 22');
    expect(loaded.keyPair.privateKey.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', loaded.keyPair.privateKey.key)).rejects.toThrow();
    again.close();
  });

  it('keeps a fallback (raw) device key encrypted under the KEK', async () => {
    const factory = new IDBFactory();
    forceX25519Backend('noble');
    const store = await openKeyStore({ factory });
    const pair = await generateX25519();
    expect(pair.privateKey.kind).toBe('raw');
    await store.saveDeviceKey(pair);
    store.close();
    const again = await openKeyStore({ factory });
    const loaded = await again.loadDeviceKey();
    expect(loaded?.privateKey.kind).toBe('raw');
    if (loaded?.privateKey.kind === 'raw' && pair.privateKey.kind === 'raw') {
      expect(hex(loaded.privateKey.bytes)).toBe(hex(pair.privateKey.bytes));
    }
    again.close();
  });

  it('is idempotent for the same ADK bytes and refuses different bytes for a stored version', async () => {
    const store = await openKeyStore({ factory: new IDBFactory() });
    const adk = generateAdk(1);
    await store.saveAdk(1, adk.raw);
    await store.saveAdk(1, adk.raw);
    await expect(store.saveAdk(1, generateAdk(1).raw)).rejects.toMatchObject({ code: 'adk_conflict' });
    expect(hex(await store.unwrapAdkRaw(1))).toBe(hex(adk.raw));
    expect(await store.allVersions()).toEqual([1]);
    store.close();
  });

  it('wipe() erases ADKs, the device key, and the KEK', async () => {
    const factory = new IDBFactory();
    const store = await openKeyStore({ factory });
    await store.saveAdk(1, generateAdk().raw);
    await getOrCreateDeviceKey(store);
    const kekBefore = await readKek(factory);
    await store.wipe();
    expect(await store.allVersions()).toEqual([]);
    expect(await store.loadDeviceKey()).toBeNull();
    await expect(store.loadSubkeys(1, 'history')).rejects.toMatchObject({ code: 'not_found' });
    store.close();
    const reopened = await openKeyStore({ factory });
    expect(await reopened.currentVersion()).toBe(0);
    const kekAfter = await readKek(factory);
    // An ADK record from before the wipe cannot be opened by the new KEK: the old KEK is gone.
    const iv = new Uint8Array(12);
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kekBefore, new Uint8Array(32));
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kekAfter, sealed)).rejects.toThrow();
    reopened.close();
  });

  it('throws a typed error when IndexedDB is unavailable or refuses to open', async () => {
    const saved = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    try {
      delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      await expect(openKeyStore()).rejects.toBeInstanceOf(KeyStoreUnavailableError);
    } finally {
      if (saved) (globalThis as { indexedDB?: IDBFactory }).indexedDB = saved;
    }
    const broken = {
      open() {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as IDBFactory;
    await expect(openKeyStore({ factory: broken })).rejects.toMatchObject({ code: 'storage_unavailable' });
  });

  it('rejects use after close', async () => {
    const store = await openKeyStore({ factory: new IDBFactory() });
    store.close();
    await expect(store.currentVersion()).rejects.toBeInstanceOf(KeyStoreUnavailableError);
  });
});
