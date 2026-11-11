import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flags } from '../../config/flags';
import { ApiError, NetworkError } from '../../lib/api/errors';
import type { TokenClaims } from '../../lib/api/token';
import { useIdentity } from '../../lib/identity/identity';
import { readPref, writePref } from '../../lib/storage';
import type { Translate } from '../../i18n/i18n';
import { useHistory } from '../history/HistoryContext';
import { accountApi, type AccountApi, type AuthResult, type Me } from './api';
import { leftAccount, phaseOf, type KeyStatus, type Phase } from './state';

/** Loaded on demand: the key steps and the crypto library they use (not part of the main bundle). */
const keyFlow = () => import('./keyFlow');
const historySync = () => import('./sync/historySync');

export type SyncStatus =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; at: number; unreadable: number }
  | { state: 'error'; offline: boolean };

export interface AccountValue {
  /** The `accounts` flag (CLAUDE.md §8b). Off: everyone is a guest and no account call is made. */
  enabled: boolean;
  /** False until the device token is known (bootstrap); account screens wait instead of redirecting. */
  known: boolean;
  /**
   * This browser held account keys the last time it was signed in (a non-secret marker). While the token is still
   * unknown (offline at load), screens show a neutral state instead of guest prompts.
   */
  accountHint: boolean;
  phase: Phase;
  userId: string | null;
  /** GET /v1/me, once loaded. */
  me: Me | null;
  /** GET /v1/me failed (offline, server error); `refreshMe` tries again. */
  meError: boolean;
  added: boolean;
  keys: KeyStatus;
  keyVersion: number;
  /**
   * A key rotation this device should have made did not go through (after a revoke, or one the server says is owed
   * because a device holding the key left: `rotation_due`, contract E). Server-backed: the next key check retries it.
   */
  rotationFailed: boolean;
  sync: SyncStatus;
  api: AccountApi;
  signIn: (mode: 'signin' | 'signup', email: string, password: string) => Promise<AuthResult>;
  /** AC-4: adds this device (optionally importing its history once) and checks the key state. */
  addDevice: (copyHistory: boolean) => Promise<KeyStatus>;
  /** AC-7: ends the account session, erases local keys, optionally clears local history; a fresh guest follows. */
  signOut: (clearHistory: boolean) => Promise<void>;
  setHistorySync: (on: boolean) => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  refreshKeys: () => Promise<KeyStatus>;
  /** Refetches GET /v1/me (after `meError`). */
  refreshMe: () => Promise<void>;
  /**
   * Rotates the Account Data Key now (DV-2 after a revoke, or Retry), never wrapping to the IDs in `exclude`. Failures
   * are reflected in `keys` (a refusal) or `rotationFailed`, never thrown.
   */
  rotateKeys: (exclude: string[]) => Promise<'rotated' | 'none' | 'failed'>;
  /**
   * DV-2: revokes another device and rotates with it excluded. The device ID is remembered (IndexedDB) before the
   * revoke, so every later rotation of this browser keeps excluding it until one that did has gone through (contract
   * I.4). Throws when the revoke itself fails; rotation failures are reported like {@link rotateKeys}.
   */
  revokeDevice: (id: string) => Promise<'rotated' | 'none' | 'failed'>;
  syncNow: () => Promise<void>;
}

const AccountContext = createContext<AccountValue | null>(null);

/** Non-secret marker that this browser holds account keys, so a guest load can erase leftovers cheaply. */
const KEYS_MARKER = 'accountKeys';

/** Background key checks (tab shown again, the 30 s tick) run at most this often, one at a time (contract I.3). */
export const KEY_CHECK_INTERVAL_MS = 30_000;

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sa-account');
  } catch {
    return null;
  }
}

/**
 * Account state for the Web (docs/UX_SCREEN_MAP.md §7–§9). The account session rides on the device token
 * (`acct`, `dl` claims, ADR 0010), so nothing here ever changes the device ID except sign-out. Keys and history
 * sync run in lazily loaded modules.
 */
export function AccountProvider({ children, enabled = flags.accounts }: { children: ReactNode; enabled?: boolean }) {
  const { client, device } = useIdentity();
  const history = useHistory();
  const api = useMemo(() => accountApi(client), [client]);
  const [claims, setClaims] = useState<TokenClaims | null>(client.claims);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState(false);
  const [rotationFailed, setRotationFailed] = useState(false);
  const [keys, setKeys] = useState<KeyStatus>('none');
  const [keyVersion, setKeyVersion] = useState(0);
  const [sync, setSync] = useState<SyncStatus>({ state: 'idle' });
  /** Bumped when a key check stored new ADK versions: a sync pass then pulls entries skipped as unreadable. */
  const [keyEpoch, setKeyEpoch] = useState(0);
  /** Set by this tab's sign-out, which erases the keys itself: the claim change that follows is expected. */
  const signedOutHere = useRef(false);
  const prevClaims = useRef<TokenClaims | null>(client.claims);
  const bc = useRef<BroadcastChannel | null>(null);
  const syncing = useRef<Promise<void> | null>(null);
  /** Key checks in flight and when the last one started (background checks are throttled on both). */
  const keyChecks = useRef({ inFlight: 0, lastAt: 0 });

  const phase = phaseOf(claims, enabled);
  const userId = phase === 'signed_in' ? (claims?.acct ?? null) : null;
  const added = phase === 'signed_in' && claims?.dl === true;
  const deviceId = device?.id ?? null;

  const announce = useCallback(() => bc.current?.postMessage('changed'), []);

  useEffect(() => client.subscribeClaims(setClaims), [client]);

  // Another tab signed in, added the device, or signed out: pick up the new token (same refresh cookie).
  useEffect(() => {
    if (!enabled) return;
    const c = channel();
    bc.current = c;
    if (c) c.onmessage = () => void client.refresh().catch(() => undefined);
    return () => {
      c?.close();
      bc.current = null;
    };
  }, [client, enabled]);

  const wipe = useCallback(async () => {
    try {
      await (await keyFlow()).wipeAccountData();
    } finally {
      writePref(KEYS_MARKER, '');
    }
  }, []);

  // Leaving the account without signing out here (revoked from another device, password reset, expiry): erase
  // the keys this browser held. A guest load also erases leftovers from a session that ended while closed.
  useEffect(() => {
    const prev = prevClaims.current;
    prevClaims.current = claims;
    if (!enabled) return;
    if (signedOutHere.current) {
      signedOutHere.current = false;
      return;
    }
    if (leftAccount(prev, claims) || (claims && !claims.acct && readPref(KEYS_MARKER) === '1')) {
      void wipe().catch(() => undefined);
    }
  }, [claims, enabled, wipe]);

  // GET /v1/me for the signed-in account; a failure is shown with Retry (refreshMe), never as an endless wait.
  const meRequest = useRef(0);
  const loadMe = useCallback(async () => {
    const id = ++meRequest.current;
    setMeError(false);
    if (!userId) {
      setMe(null);
      return;
    }
    try {
      const m = await api.me();
      if (id === meRequest.current) setMe(m);
    } catch {
      if (id === meRequest.current) setMeError(true);
    }
  }, [api, userId]);

  // A newer request (another account, Retry) supersedes an older one still in flight.
  useEffect(() => {
    setMe(null);
    void loadMe();
  }, [loadMe, added]);

  /**
   * Runs a key check and reflects it. A `quiet` (background) check shows no "checking" state and keeps the current one
   * when it only failed to reach the server, so a ready tab does not flip to an error while briefly offline.
   */
  const runKeyCheck = useCallback(
    async (acct: string, dev: string, quiet = false): Promise<KeyStatus> => {
      if (!quiet) setKeys((k) => (k === 'ready' ? k : 'checking'));
      keyChecks.current.inFlight++;
      keyChecks.current.lastAt = Date.now();
      try {
        const flow = await keyFlow();
        const res = await flow.checkKeys(api, acct, dev);
        writePref(KEYS_MARKER, '1');
        setKeyVersion(res.keyVersion);
        setKeys(res.status);
        setRotationFailed(res.rotationOwed);
        if (res.newVersions.length) setKeyEpoch((n) => n + 1);
        return res.status;
      } catch (e) {
        const status = keyErrorStatus(e);
        if (!quiet || status !== 'error') setKeys(status);
        return status;
      } finally {
        keyChecks.current.inFlight--;
      }
    },
    [api],
  );

  const refreshKeys = useCallback(async (): Promise<KeyStatus> => {
    if (!userId || !added || !deviceId) {
      setKeys('none');
      return 'none';
    }
    return runKeyCheck(userId, deviceId);
  }, [userId, added, deviceId, runKeyCheck]);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  /**
   * Contract I.3: open tabs pick up rotations (and re-prove, and make owed rotations) without a reload: a quiet key
   * check when the tab becomes visible and on the 30 s tick, at most one in flight and at most once per 30 s.
   */
  const backgroundKeyCheck = useCallback(() => {
    if (!userId || !added || !deviceId) return;
    const c = keyChecks.current;
    if (c.inFlight > 0 || Date.now() - c.lastAt < KEY_CHECK_INTERVAL_MS) return;
    void runKeyCheck(userId, deviceId, true);
  }, [userId, added, deviceId, runKeyCheck]);

  useEffect(() => {
    if (!userId || !added || !deviceId || typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') backgroundKeyCheck();
    };
    document.addEventListener('visibilitychange', onVisible);
    const id = setInterval(onVisible, KEY_CHECK_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(id);
    };
  }, [userId, added, deviceId, backgroundKeyCheck]);

  const rotateKeys = useCallback(
    async (exclude: string[]): Promise<'rotated' | 'none' | 'failed'> => {
      if (!userId || !added || !deviceId) return 'failed';
      const flow = await keyFlow();
      try {
        const r = await flow.rotateKeys(api, userId, deviceId, exclude);
        setRotationFailed(false);
        await runKeyCheck(userId, deviceId);
        return r;
      } catch (e) {
        if (e instanceof Error && e.name === 'KeyStateError' && (e as { code?: string }).code === 'not_ready') {
          // This device lacks the newest key (another device rotated meanwhile): a key check picks it up or says to
          // pair, instead of offering a Retry that cannot work (contract I.5).
          setRotationFailed(false);
          await runKeyCheck(userId, deviceId);
          return 'failed';
        }
        const status = flow.rotationErrorStatus(e);
        if (status) setKeys(status);
        else setRotationFailed(true);
        return 'failed';
      }
    },
    [api, userId, added, deviceId, runKeyCheck],
  );

  const revokeDevice = useCallback(
    async (id: string): Promise<'rotated' | 'none' | 'failed'> => {
      if (userId) {
        const flow = await keyFlow();
        // Fails closed: if the account's key version cannot be read, nothing is revoked and the user retries (QA round 8).
        await flow.rememberRevoked(userId, [id], api);
        try {
          await api.revokeDevice(id);
        } catch (e) {
          // The server answered and kept the device: it must not stay excluded from later rotations. When the request
          // did not get an answer (offline), the device may be revoked already, so it stays excluded to be safe.
          if (e instanceof ApiError) await flow.forgetRevoked(userId, [id]).catch(() => undefined);
          throw e;
        }
      } else {
        await api.revokeDevice(id);
      }
      // Never wrap the new key to the device just revoked, whatever the server lists (contract D.3).
      return rotateKeys([id]);
    },
    [api, userId, rotateKeys],
  );

  const syncNow = useCallback(async () => {
    if (!userId || !added || !deviceId || keys !== 'ready' || !history.store) return;
    if (syncing.current) return syncing.current;
    const store = history.store;
    const run = (async () => {
      setSync({ state: 'running' });
      try {
        const [flow, hs] = await Promise.all([keyFlow(), historySync()]);
        const names = new Map<string, string>();
        if (me?.history_sync) {
          const list = await api.devices().catch(() => null);
          for (const d of list?.devices ?? []) names.set(d.id, d.name);
        }
        const res = await hs.syncHistory({
          api,
          keys: await flow.keyStore(),
          history: store,
          meta: flow.syncMeta(),
          userId,
          deviceId,
          enabled: me?.history_sync === true,
          deviceNames: names,
          // An upload under an older key than the account's (409 key_version_conflict): pick up the rotation, retry once.
          onKeyConflict: () => runKeyCheck(userId, deviceId, true),
        });
        if (res.pulled || res.removed) await history.refresh();
        setSync({ state: 'ok', at: Date.now(), unreadable: res.unreadable });
      } catch (e) {
        setSync({
          state: 'error',
          offline: e instanceof NetworkError || (typeof navigator !== 'undefined' && !navigator.onLine),
        });
      } finally {
        syncing.current = null;
      }
    })();
    syncing.current = run;
    return run;
  }, [api, userId, added, deviceId, keys, me?.history_sync, history, runKeyCheck]);

  // Sync when the device becomes ready (a pending "copy history" import runs even with sync off), then every
  // 30 s while sync is on and the tab is visible.
  useEffect(() => {
    if (keys !== 'ready' || !me) return;
    void keyEpoch;
    void syncNow();
    if (!me.history_sync) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      backgroundKeyCheck();
      void syncNow();
    }, 30_000);
    return () => clearInterval(id);
  }, [keys, me, syncNow, keyEpoch, backgroundKeyCheck]);

  // Local deletions tombstone the synced copies while sync is on (queued when offline).
  useEffect(() => {
    if (!userId || !added || !me?.history_sync) {
      history.setSyncHandler(null);
      return;
    }
    const deps = async () => ({ api, meta: (await keyFlow()).syncMeta(), userId });
    const report = () => setSync({ state: 'error', offline: typeof navigator !== 'undefined' && !navigator.onLine });
    history.setSyncHandler({
      removed: (ids) =>
        void Promise.all([historySync(), deps()])
          .then(([hs, d]) => hs.deleteSynced(d, ids))
          .catch(report),
      cleared: () =>
        void Promise.all([historySync(), deps()])
          .then(([hs, d]) => hs.clearSynced(d))
          .catch(report),
    });
    return () => history.setSyncHandler(null);
  }, [api, userId, added, me?.history_sync, history]);

  const signIn = useCallback(
    async (mode: 'signin' | 'signup', email: string, password: string) => {
      const res = await (mode === 'signin' ? api.signIn(email, password) : api.signUp(email, password));
      client.acceptToken(res);
      announce();
      return res;
    },
    [api, client, announce],
  );

  const addDevice = useCallback(
    async (copyHistory: boolean) => {
      const res = await api.addCurrent(copyHistory);
      const acct = client.claims?.acct;
      if (acct) {
        const meta = (await keyFlow()).syncMeta();
        const m = await meta.get(acct);
        await meta.put({ ...m, pushSince: Date.now(), importPending: copyHistory }).catch(() => undefined);
      }
      client.acceptToken(res);
      announce();
      const dev = client.device?.id;
      return acct && dev ? runKeyCheck(acct, dev) : 'error';
    },
    [api, client, announce, runKeyCheck],
  );

  const signOut = useCallback(
    async (clearHistory: boolean) => {
      const session = await api.signOut();
      // The server already ended the session and deleted the wrapped keys; local erasure follows even if it fails.
      await wipe().catch(() => undefined);
      if (clearHistory && history.store) await history.store.clear().catch(() => undefined);
      signedOutHere.current = true;
      client.acceptSession(session);
      await history.refresh();
      setMe(null);
      setRotationFailed(false);
      setSync({ state: 'idle' });
      announce();
    },
    [api, client, history, wipe, announce],
  );

  const setHistorySync = useCallback(
    async (on: boolean) => {
      const m = await api.setHistorySync(on);
      setMe(m);
    },
    [api],
  );

  const changePassword = useCallback(
    async (current: string, next: string) => {
      await api.changePassword(current, next);
    },
    [api],
  );

  const value = useMemo<AccountValue>(
    () => ({
      enabled,
      known: claims !== null,
      accountHint: claims === null && readPref(KEYS_MARKER) === '1',
      phase,
      userId,
      me,
      meError,
      added,
      keys: added ? keys : 'none',
      keyVersion,
      rotationFailed: added && rotationFailed,
      sync,
      api,
      signIn,
      addDevice,
      signOut,
      setHistorySync,
      changePassword,
      refreshKeys,
      refreshMe: loadMe,
      rotateKeys,
      revokeDevice,
      syncNow,
    }),
    [
      enabled,
      claims,
      phase,
      userId,
      me,
      meError,
      added,
      keys,
      keyVersion,
      rotationFailed,
      sync,
      api,
      signIn,
      addDevice,
      signOut,
      setHistorySync,
      changePassword,
      refreshKeys,
      loadMe,
      rotateKeys,
      revokeDevice,
      syncNow,
    ],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const v = useContext(AccountContext);
  if (!v) throw new Error('useAccount outside AccountProvider');
  return v;
}

/** Codes of the server refusing this device's own rotation or key registration (contract F.3). */
const REFUSED = ['refused', 'rotation_unauthorized', 'device_key_unproven', 'key_version_conflict'];

/**
 * Key state for a failed key check: storage problems, an incoming key change that did not verify (`rejected`), the
 * server refusing this device's own update (`refused`), legacy keys, anything else.
 */
export function keyErrorStatus(e: unknown): KeyStatus {
  const code = (e as { code?: string } | null)?.code;
  if (
    e instanceof Error &&
    (e.name === 'KeyStoreUnavailableError' || code === 'unsupported' || code === 'storage_unavailable')
  )
    return 'unavailable';
  if (code === 'keys_legacy' || code === 'legacy') return 'legacy';
  if (code === 'unverified' || code === 'rejected') return 'rejected';
  if (code !== undefined && REFUSED.includes(code)) return 'refused';
  return 'error';
}

/** Inline message for an account API error (docs/API.md §3). */
export function accountErrorText(e: unknown, t: Translate): string {
  if (e instanceof ApiError && (e.code === 'rate_limited' || e.code === 'locked_out') && e.retryAfterS) {
    const m = Math.floor(e.retryAfterS / 60);
    return t('product.rate_limited', { time: `${m}:${String(e.retryAfterS % 60).padStart(2, '0')}` });
  }
  return t(accountErrorKey(e));
}

function accountErrorKey(e: unknown): string {
  if (e instanceof NetworkError) return 'product.acct_offline';
  const code = (e as { code?: string } | null)?.code;
  // Key authenticity outcomes (CryptoError or ApiError codes, docs/CLIPBOARD_PROTOCOL.md §1).
  if (code === 'keys_legacy') return 'product.keys_legacy';
  if (code === 'recovery_unverified') return 'product.phrase_unverified';
  if (code === 'unverified') return 'product.key_change_unverified';
  if (code === 'refused' || code === 'rotation_unauthorized' || code === 'device_key_unproven')
    return 'product.keys_refused';
  if (!(e instanceof ApiError)) return 'product.error_generic';
  switch (e.code) {
    case 'invalid_credentials':
      return 'product.acct_invalid_credentials';
    case 'email_taken':
      return 'product.acct_email_taken';
    case 'invalid_email':
      return 'product.email_invalid';
    case 'weak_password':
      return 'product.acct_weak_password';
    case 'reset_token_invalid':
      return 'product.acct_reset_invalid';
    case 'rate_limited':
    case 'locked_out':
      return 'product.acct_rate_limited';
    default:
      return 'product.error_generic';
  }
}
