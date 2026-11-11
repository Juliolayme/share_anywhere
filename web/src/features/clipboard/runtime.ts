// The Clipboard Sync runtime the app loads for a ready account (signed in, device added, key held): engine, capture
// capability, automatic capture, in-page copies, WebSocket-driven cursor sync. Guests never load this module.
import type { DeviceClient } from '../../lib/api/device-client';
import type { SocketEvent } from '../../lib/ws/socket';
import { accountApi } from '../account/api';
import { keyStore } from '../account/keyFlow';
import { clipboardApi, type ClipboardApi, type ClipboardSettings } from './api';
import {
  ClipboardReadError,
  hasReadText,
  isSecure,
  onFocusOrVisible,
  onInPageCopy,
  readClipboardText,
  watchReadPermission,
  writeClipboardText,
  type ReadFailure,
} from './capture';
import {
  ClipboardEngine,
  type CaptureResult,
  type CaptureSource,
  type ClipboardSnapshot,
  type KeySource,
} from './engine';
import { getAutoCapture, subscribeAutoCapture } from './prefs';
import { deriveCaptureStatus, mayAutoRead, type CaptureStatus, type ReadPermission } from './status';
import { clipboardStore, type ClipboardStore } from './store';

export interface RuntimeState {
  snapshot: ClipboardSnapshot;
  status: CaptureStatus;
  permission: ReadPermission;
  hasRead: boolean;
  secure: boolean;
  autoCapture: boolean;
  online: boolean;
  /** Account device names by ID (GET /v1/devices) for the origin of each row. */
  deviceNames: Record<string, string>;
}

export type ManualRead = { ok: true; text: string } | { ok: false; reason: ReadFailure };

export interface ClipboardRuntime {
  readonly engine: ClipboardEngine;
  state(): RuntimeState;
  subscribe(fn: () => void): () => void;
  /** Manual Sync: reads the clipboard. Call it directly from the click handler (user gesture), before any await. */
  readForSync(): Promise<ManualRead>;
  capture(text: string, source: CaptureSource, force?: boolean): Promise<CaptureResult>;
  /** Copy: writes the row's text to the clipboard (from a click). False when the browser refused both ways. */
  copy(id: string): Promise<boolean>;
  onSocket(e: SocketEvent): void;
  keysChanged(): void;
  stop(): void;
}

export interface RuntimeOptions {
  client: DeviceClient;
  userId: string;
  deviceId: string;
  onKeyConflict: () => Promise<unknown>;
  /** Tests inject these. */
  api?: ClipboardApi;
  keys?: KeySource;
  store?: ClipboardStore;
  devices?: () => Promise<{ devices: { id: string; name: string }[] }>;
}

const bool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Settings from a `CLIPBOARD_SETTINGS_UPDATED` message, or null when the payload is not the expected shape. */
export function settingsFromEvent(e: SocketEvent): ClipboardSettings | null {
  const { paused, retention_days: days, sensitive_skip: skip } = e;
  if (!bool(paused) || !bool(skip) || typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 7)
    return null;
  return { paused, retention_days: days, sensitive_skip: skip };
}

export async function createRuntime(opts: RuntimeOptions): Promise<ClipboardRuntime> {
  const engine = new ClipboardEngine({
    api: opts.api ?? clipboardApi(opts.client),
    keys: opts.keys ?? (await keyStore()),
    store: opts.store ?? clipboardStore(),
    userId: opts.userId,
    deviceId: opts.deviceId,
    onKeyConflict: opts.onKeyConflict,
  });
  const listDevices = opts.devices ?? (() => accountApi(opts.client).devices());
  const listeners = new Set<() => void>();
  const secure = isSecure();
  const hasRead = hasReadText();
  let permission: ReadPermission = 'unsupported';
  let autoCapture = getAutoCapture();
  let online = typeof navigator === 'undefined' ? true : navigator.onLine;
  let deviceNames: Record<string, string> = {};
  let namesAt = 0;
  let reading = false;
  let stopped = false;
  const cleanups: (() => void)[] = [];

  const compute = (): RuntimeState => {
    const snapshot = engine.snapshot();
    const reachable = online && snapshot.sendError !== 'offline' && snapshot.loadError !== 'offline';
    const status = deriveCaptureStatus({
      secure,
      hasRead,
      permission,
      autoCapture,
      online: reachable,
      paused: snapshot.settings?.paused === true,
    });
    return { snapshot, status, permission, hasRead, secure, autoCapture, online: reachable, deviceNames };
  };
  let current = compute();
  const emit = () => {
    if (stopped) return;
    current = compute();
    for (const l of listeners) l();
  };
  cleanups.push(engine.subscribe(emit));

  const refreshNames = (force = false) => {
    if (!force && Date.now() - namesAt < 30_000) return;
    namesAt = Date.now();
    void listDevices()
      .then(({ devices }) => {
        deviceNames = Object.fromEntries(devices.map((d) => [d.id, d.name]));
        emit();
      })
      .catch(() => undefined);
  };

  const recheckPermission = async () => {
    const w = await watchReadPermission(() => undefined);
    w.stop();
    if (w.state !== permission) {
      permission = w.state;
      emit();
    }
  };

  // Automatic capture: an opportunistic read when the tab gains focus or becomes visible, only while the site's
  // clipboard-read permission is already granted and the toggle is on (status `auto`). Never polling, never prompting.
  const autoRead = async () => {
    if (stopped || reading) return;
    const may = mayAutoRead({
      secure,
      hasRead,
      permission,
      autoCapture,
      online: true,
      paused: current.snapshot.settings?.paused === true,
    });
    if (!may) return;
    reading = true;
    try {
      const text = await readClipboardText();
      await engine.capture(text, 'auto');
    } catch (e) {
      if (e instanceof ClipboardReadError && e.reason === 'denied') await recheckPermission();
    } finally {
      reading = false;
    }
  };

  const onOnline = () => {
    online = navigator.onLine;
    emit();
    if (online) {
      void engine.flush();
      void engine.refresh();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    cleanups.push(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
    });
  }
  cleanups.push(
    subscribeAutoCapture(() => {
      autoCapture = getAutoCapture();
      emit();
    }),
  );
  cleanups.push(
    onFocusOrVisible(() => {
      void autoRead();
      // Catch up with anything a missed notification would have announced (one cheap cursor read).
      void engine.refresh();
    }),
  );
  cleanups.push(
    onInPageCopy((text) => {
      if (autoCapture && !current.snapshot.settings?.paused) void engine.capture(text, 'copy');
    }),
  );

  const watched = await watchReadPermission((p) => {
    permission = p;
    emit();
  });
  permission = watched.state;
  cleanups.push(watched.stop);
  emit();
  refreshNames(true);
  void engine.start();

  return {
    engine,
    state: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    readForSync() {
      return readClipboardText().then(
        (text): ManualRead => ({ ok: true, text }),
        async (e: unknown): Promise<ManualRead> => {
          const reason = e instanceof ClipboardReadError ? e.reason : 'failed';
          if (reason === 'denied') await recheckPermission();
          return { ok: false, reason };
        },
      );
    },
    capture: (text, source, force) => engine.capture(text, source, force),
    async copy(id) {
      const item = engine.snapshot().items.find((i) => i.id === id);
      if (!item?.text) return false;
      const ok = await writeClipboardText(item.text);
      if (ok) engine.markCopied(id);
      return ok;
    },
    onSocket(e) {
      switch (e.type) {
        case 'CLIPBOARD_EVENT_CREATED':
          if (typeof e.origin_device_id === 'string' && !(e.origin_device_id in deviceNames)) refreshNames();
          void engine.refresh();
          break;
        case 'CLIPBOARD_EVENT_DELETED':
        case 'CLIPBOARD_HISTORY_CLEARED':
          void engine.refresh();
          break;
        case 'CLIPBOARD_SETTINGS_UPDATED': {
          const s = settingsFromEvent(e);
          if (s) engine.applySettings(s);
          else void engine.loadSettings();
          break;
        }
        case 'DEVICE_CONNECTED':
          if (typeof e.device_id === 'string' && !(e.device_id in deviceNames)) refreshNames();
          break;
        case 'SOCKET_OPEN':
          void engine.refresh();
          void engine.flush();
          break;
        default:
          break;
      }
    },
    keysChanged: () => void engine.keysChanged(),
    stop() {
      stopped = true;
      engine.stop();
      for (const c of cleanups.splice(0)) c();
      listeners.clear();
    },
  };
}
