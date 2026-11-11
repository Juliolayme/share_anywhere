import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { flags } from '../../config/flags';
import { useIdentity } from '../../lib/identity/identity';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n/i18n';
import { useAccount } from '../account/AccountContext';
import { useSocketEvents } from '../sharing/SharingContext';
import type { ClipboardRuntime, RuntimeState } from './runtime';

export interface ClipboardValue {
  /** The `clipboard` flag (CLAUDE.md §8b) and the `accounts` flag it depends on. */
  enabled: boolean;
  /** Signed in, device added, key held: the runtime is (being) loaded. */
  ready: boolean;
  runtime: ClipboardRuntime | null;
  /** Loading the runtime failed (offline at first load of the chunk, storage error): Retry loads it again. */
  failed: boolean;
  retry: () => void;
}

const disabled: ClipboardValue = { enabled: false, ready: false, runtime: null, failed: false, retry: () => undefined };
const ClipboardContext = createContext<ClipboardValue>(disabled);

/**
 * Clipboard Sync for the whole app (docs/UX_SCREEN_MAP.md §10). The runtime, which alone touches the browser
 * clipboard, is imported only once the account is ready on this device: a guest, a device not added to the account,
 * or one without the key never loads it, so they make no clipboard call of any kind (PRD §5.9). It stops and is
 * dropped as soon as that changes (sign-out, revoke, session end); the account wipe erases its stored data.
 */
export function ClipboardProvider({
  children,
  enabled = flags.clipboard && flags.accounts,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const account = useAccount();
  const { client, device } = useIdentity();
  const [runtime, setRuntime] = useState<ClipboardRuntime | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const userId = account.userId;
  const deviceId = device?.id ?? null;
  const ready = enabled && account.phase === 'signed_in' && account.added && account.keys === 'ready' && !!userId;
  const { refreshKeys } = account;
  const refreshKeysRef = useRef(refreshKeys);
  refreshKeysRef.current = refreshKeys;

  useEffect(() => {
    if (!ready || !userId || !deviceId) {
      setRuntime(null);
      return;
    }
    let cancelled = false;
    let created: ClipboardRuntime | null = null;
    setFailed(false);
    void import('./runtime')
      .then((m) => m.createRuntime({ client, userId, deviceId, onKeyConflict: () => refreshKeysRef.current() }))
      .then((rt) => {
        created = rt;
        if (cancelled) rt.stop();
        else setRuntime(rt);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      created?.stop();
      setRuntime(null);
    };
  }, [ready, userId, deviceId, client, attempt]);

  // A key check that picked up a rotation: rows locked so far are decrypted, and queued events are sent.
  const keyVersion = account.keyVersion;
  useEffect(() => {
    if (runtime && keyVersion > 0) runtime.keysChanged();
  }, [runtime, keyVersion]);

  // CLIPBOARD_* metadata over the WebSocket → fetch by cursor (docs/CLIPBOARD_PROTOCOL.md §2.4).
  useSocketEvents((e) => runtime?.onSocket(e), runtime !== null);

  useIncomingToast(runtime);

  const value: ClipboardValue = {
    enabled,
    ready,
    runtime,
    failed,
    retry: () => setAttempt((n) => n + 1),
  };
  return <ClipboardContext.Provider value={value}>{children}</ClipboardContext.Provider>;
}

export function useClipboard(): ClipboardValue {
  return useContext(ClipboardContext);
}

const noop = () => () => undefined;

/** The runtime's state, or null while it is not loaded. */
export function useClipboardState(runtime: ClipboardRuntime | null): RuntimeState | null {
  return useSyncExternalStore(
    runtime ? runtime.subscribe : noop,
    () => (runtime ? runtime.state() : null),
    () => null,
  );
}

/** "New clipboard item from …" when another device's item arrives while this tab is elsewhere in the app. */
function useIncomingToast(runtime: ClipboardRuntime | null) {
  const { t } = useI18n();
  const toast = useToast();
  const { pathname } = useLocation();
  const state = useClipboardState(runtime);
  const seen = useRef<Set<string>>(new Set());
  const onClipboard = pathname.startsWith('/clipboard');
  useEffect(() => {
    if (!state) {
      seen.current = new Set();
      return;
    }
    const fresh = state.snapshot.items.filter((i) => i.incoming && !seen.current.has(i.id));
    for (const i of fresh) seen.current.add(i.id);
    const newest = fresh[0];
    if (newest && !onClipboard) {
      toast.show(
        t('web_patterns.new_clipboard_item_from_x', [state.deviceNames[newest.origin] ?? t('product.cb_other_device')]),
      );
    }
  }, [state, onClipboard, toast, t]);
}
