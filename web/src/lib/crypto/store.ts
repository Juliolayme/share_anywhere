import { ADK_BYTES, deriveSubkeyFrom, type SubkeyPurpose, assertPurpose } from './adk';
import { CryptoError, KeyStoreUnavailableError } from './errors';
import { assertLength, assertVersion, copyBytes, equalBytes, randomBytes, utf8, zeroize, type Bytes } from './encoding';
import { NONCE_BYTES, gcmDecrypt, gcmEncrypt, subtle } from './primitives';
import type { X25519KeyPair } from './x25519';

/**
 * Device-local key store in IndexedDB (docs/CLIPBOARD_PROTOCOL.md §Keys "Local storage").
 * - `meta/kek`: a non-extractable AES-256-GCM device KEK, generated once per browser profile. IndexedDB
 *   keeps the CryptoKey by structured clone, so its bytes are never visible to script.
 * - `adk/<version>`: each ADK version encrypted under the KEK with AAD `adk|<version>`.
 * - `meta/device`: the X25519 device wrapping keypair (a non-extractable CryptoKey; on the fallback
 *   backend the private scalar encrypted under the KEK with AAD `device|x25519`).
 * Subkeys are unwrapped from the record straight into a non-extractable HKDF key, so normal reads never put
 * ADK bytes in script memory; only {@link KeyStore.unwrapAdkRaw} does, transiently, for pairing and rotation.
 * Nothing here uses Web Storage. `wipe()` on sign-out erases every record including the KEK.
 */
export const KEY_DB_NAME = 'share-anywhere-keys';
const DB_VERSION = 1;
const META = 'meta';
const ADKS = 'adk';
const KEK_ID = 'kek';
const DEVICE_ID = 'device';
const DEVICE_AAD = 'device|x25519';

interface AdkRecord {
  version: number;
  nonce: Bytes;
  ct: Bytes;
}

type DeviceRecord =
  | { kind: 'webcrypto'; privateKey: CryptoKey; publicKey: Bytes }
  | { kind: 'raw'; nonce: Bytes; ct: Bytes; publicKey: Bytes };

export interface KeyStoreOptions {
  /** Database name (tests use a fresh one or a fresh factory). */
  name?: string;
  /** IndexedDB factory; defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function completion(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    // A failed request aborts the transaction unless its handler prevented that, so abort is the outcome.
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function adkAad(version: number): Bytes {
  return utf8(`adk|${version}`);
}

async function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(name, DB_VERSION);
    } catch (cause) {
      reject(new KeyStoreUnavailableError('IndexedDB refused to open', { cause }));
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(ADKS)) db.createObjectStore(ADKS, { keyPath: 'version' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new KeyStoreUnavailableError('IndexedDB refused to open', { cause: r.error }));
    r.onblocked = () => reject(new KeyStoreUnavailableError('IndexedDB upgrade blocked by another tab'));
  });
}

/** Opens (and on first use initializes) the key store. Throws {@link KeyStoreUnavailableError}. */
export async function openKeyStore(options: KeyStoreOptions = {}): Promise<KeyStore> {
  const factory = options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) throw new KeyStoreUnavailableError('IndexedDB is not available in this browser');
  subtle(); // fail early without WebCrypto
  const db = await openDb(factory, options.name ?? KEY_DB_NAME);
  const store = new KeyStore(db);
  try {
    await store.ensureKek();
  } catch (cause) {
    db.close();
    throw cause instanceof CryptoError ? cause : new KeyStoreUnavailableError('IndexedDB write failed', { cause });
  }
  return store;
}

/** Asks the browser not to evict this origin's storage (losing it means re-pairing). True when granted. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export class KeyStore {
  private kek: CryptoKey | null = null;
  private closed = false;
  private readonly subkeys = new Map<string, Promise<CryptoKey>>();

  /** Use {@link openKeyStore}. @internal */
  constructor(private readonly db: IDBDatabase) {
    db.onversionchange = () => this.close();
  }

  private live(): IDBDatabase {
    if (this.closed) throw new KeyStoreUnavailableError('key store is closed');
    return this.db;
  }

  private async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const t = this.live().transaction(storeName, 'readonly');
    const value = await request(t.objectStore(storeName).get(key) as IDBRequest<T | undefined>);
    return value;
  }

  private async put(storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
    const t = this.live().transaction(storeName, 'readwrite');
    t.objectStore(storeName).put(value, key);
    await completion(t);
  }

  /** Loads the KEK, creating it in the same transaction as the check so two tabs agree on one. @internal */
  async ensureKek(): Promise<CryptoKey> {
    if (this.kek) return this.kek;
    const existing = await this.get<CryptoKey>(META, KEK_ID);
    if (existing) return (this.kek = existing);
    const fresh = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
      'unwrapKey',
    ]);
    const t = this.live().transaction(META, 'readwrite');
    const meta = t.objectStore(META);
    let chosen: CryptoKey = fresh;
    const r = meta.get(KEK_ID) as IDBRequest<CryptoKey | undefined>;
    r.onsuccess = () => {
      if (r.result) chosen = r.result;
      else meta.put(fresh, KEK_ID);
    };
    await completion(t);
    return (this.kek = chosen);
  }

  /** Stores ADK `version`. Idempotent for identical bytes; different bytes for a stored version → `adk_conflict`. */
  async saveAdk(version: number, raw: Uint8Array): Promise<void> {
    assertVersion(version);
    assertLength(raw, ADK_BYTES, 'ADK');
    const kek = await this.ensureKek();
    const nonce = randomBytes(NONCE_BYTES);
    const record: AdkRecord = { version, nonce, ct: await gcmEncrypt(kek, nonce, adkAad(version), raw) };
    const t = this.live().transaction(ADKS, 'readwrite');
    const add = t.objectStore(ADKS).add(record);
    let exists = false;
    add.onerror = (event) => {
      if (add.error?.name !== 'ConstraintError') return; // anything else aborts the transaction
      exists = true;
      event.preventDefault(); // the transaction itself completes without writing
      event.stopPropagation();
    };
    try {
      await completion(t);
    } catch (cause) {
      throw new KeyStoreUnavailableError('IndexedDB write failed', { cause });
    }
    if (!exists) return;
    const stored = await this.unwrapAdkRaw(version);
    const same = equalBytes(stored, raw);
    zeroize(stored);
    if (!same) throw new CryptoError('adk_conflict', `a different ADK version ${version} is already stored`);
  }

  async hasAdk(version: number): Promise<boolean> {
    assertVersion(version);
    return (await this.get<AdkRecord>(ADKS, version)) !== undefined;
  }

  /** Ascending list of stored ADK versions. */
  async allVersions(): Promise<number[]> {
    const t = this.live().transaction(ADKS, 'readonly');
    const keys = await request(t.objectStore(ADKS).getAllKeys());
    return keys.filter((k): k is number => typeof k === 'number').sort((a, b) => a - b);
  }

  /** Newest stored ADK version, or 0 when the device holds no ADK yet. */
  async currentVersion(): Promise<number> {
    const all = await this.allVersions();
    return all[all.length - 1] ?? 0;
  }

  private async record(version: number): Promise<AdkRecord> {
    assertVersion(version);
    const rec = await this.get<AdkRecord>(ADKS, version);
    if (!rec) throw new CryptoError('not_found', `no ADK version ${version} on this device`);
    return rec;
  }

  /**
   * The `history` or `clipboard` subkey of ADK `version` as a non-extractable AES-256-GCM key (cached per
   * store instance). The ADK goes from its record straight into a non-extractable HKDF key.
   */
  loadSubkeys(version: number, purpose: SubkeyPurpose): Promise<CryptoKey> {
    assertPurpose(purpose);
    const id = `${version}|${purpose}`;
    let key = this.subkeys.get(id);
    if (!key) {
      key = (async () => {
        const rec = await this.record(version);
        const kek = await this.ensureKek();
        const params = { name: 'AES-GCM', iv: copyBytes(rec.nonce), additionalData: adkAad(version) };
        let hkdf: CryptoKey;
        try {
          hkdf = await subtle().unwrapKey('raw', copyBytes(rec.ct), kek, params, 'HKDF', false, ['deriveKey']);
        } catch (cause) {
          throw new CryptoError('decrypt_failed', `stored ADK version ${version} does not open`, { cause });
        }
        return deriveSubkeyFrom(hkdf, purpose);
      })();
      key.catch(() => this.subkeys.delete(id));
      this.subkeys.set(id, key);
    }
    return key;
  }

  /** Raw ADK bytes for wrapping (pairing, rotation, recovery). Transient: zeroize them when done. */
  async unwrapAdkRaw(version: number): Promise<Bytes> {
    const rec = await this.record(version);
    return gcmDecrypt(await this.ensureKek(), rec.nonce, adkAad(version), rec.ct);
  }

  async saveDeviceKey(keyPair: X25519KeyPair): Promise<void> {
    assertLength(keyPair.publicKey, 32, 'device public key');
    const publicKey = copyBytes(keyPair.publicKey);
    let rec: DeviceRecord;
    if (keyPair.privateKey.kind === 'webcrypto') {
      rec = { kind: 'webcrypto', privateKey: keyPair.privateKey.key, publicKey };
    } else {
      const nonce = randomBytes(NONCE_BYTES);
      const ct = await gcmEncrypt(await this.ensureKek(), nonce, utf8(DEVICE_AAD), keyPair.privateKey.bytes);
      rec = { kind: 'raw', nonce, ct, publicKey };
    }
    await this.put(META, rec, DEVICE_ID);
  }

  async loadDeviceKey(): Promise<X25519KeyPair | null> {
    const rec = await this.get<DeviceRecord>(META, DEVICE_ID);
    if (!rec) return null;
    if (rec.kind === 'webcrypto')
      return { privateKey: { kind: 'webcrypto', key: rec.privateKey }, publicKey: rec.publicKey };
    const bytes = await gcmDecrypt(await this.ensureKek(), rec.nonce, utf8(DEVICE_AAD), rec.ct);
    return { privateKey: { kind: 'raw', bytes }, publicKey: rec.publicKey };
  }

  /** Sign-out: erases the ADKs, the device key, and the KEK. The store stays usable (a new KEK on next use). */
  async wipe(): Promise<void> {
    const t = this.live().transaction([META, ADKS], 'readwrite');
    t.objectStore(META).clear();
    t.objectStore(ADKS).clear();
    await completion(t);
    this.kek = null;
    this.subkeys.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.kek = null;
    this.subkeys.clear();
    this.db.close();
  }
}
