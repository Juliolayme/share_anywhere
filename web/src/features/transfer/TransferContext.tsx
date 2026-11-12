import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DeviceClient } from '../../lib/api/device-client';
import { useIdentity } from '../../lib/identity/identity';
import { useKeepAwakeController } from '../../lib/keepAwake/KeepAwakeContext';
import type { KeepAwakeController } from '../../lib/keepAwake/controller';
import type { SessionSocket } from '../../lib/ws/socket';
import type { HistoryStore } from '../history/store/history-store';
import { useHistory } from '../history/HistoryContext';
import { useSharing } from '../sharing/SharingContext';
import type { sessionsApi } from '../sharing/api';
import { transfersApi } from './runtime/api';
import { pushDiag } from './runtime/rtc';
import { cloudApi } from './cloud/api';
import { cloudChosenFor, getOutbox } from './runtime/outbox';
import type { Observable } from './runtime/observable';
import { ReceiverController, rxActive, type RxState } from './runtime/receiver-controller';
import { SenderController, txActive, type TxState } from './runtime/sender-controller';
import { openProgressStore, type ProgressStore } from './storage/progress-store';
import { sweepStorage } from './storage/sweep';

/**
 * One controller per session for the life of the tab (module scope, so this code ships only with the lazily
 * loaded session screens), so a transfer survives navigation between the session, dashboard, and history.
 */
const receivers = new Map<string, ReceiverController>();
const senders = new Map<string, SenderController>();
let progress: ProgressStore | null = null;
let keepAwake: KeepAwakeController | null = null;

/**
 * Every transfer this tab takes part in holds the screen on while it is active, whichever page is showing
 * (docs/ARCHITECTURE.md §7.1): opening History mid-transfer does not let the screen sleep.
 */
function holdWhileActive<T>(c: Observable<T>, active: (s: T) => boolean): void {
  const holder = Symbol('transfer');
  const apply = () => keepAwake?.hold(holder, active(c.state));
  c.subscribe(apply);
  apply();
}

interface Deps {
  keepAwake?: KeepAwakeController;
  client: DeviceClient;
  sessions: ReturnType<typeof sessionsApi>;
  socket: SessionSocket;
  history: HistoryStore | null;
}

interface TestHooks {
  receivers: Record<string, ReceiverController>;
  senders: Record<string, SenderController>;
}

function hooks(): TestHooks | null {
  if (import.meta.env.VITE_TEST_HOOKS !== 'true') return null;
  const w = window as unknown as { __saTest?: TestHooks };
  w.__saTest ??= { receivers: {}, senders: {} };
  return w.__saTest;
}

/**
 * Test builds only: the receiver's ICE diagnostics survive a reload (sessionStorage), so a failure after a
 * reload can be compared with the connection before it.
 */
function keepDiagAcrossLoads(sessionId: string, diag: string[]): void {
  const key = `sa.test.diag.${sessionId}`;
  try {
    // eslint-disable-next-line no-restricted-globals -- test builds only: ICE diagnostics, no tokens or secrets
    const prev = JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[];
    for (const l of prev.slice(-150)) pushDiag(diag, `prev: ${l}`);
  } catch {
    /* ignore */
  }
  window.addEventListener('pagehide', () => {
    try {
      // eslint-disable-next-line no-restricted-globals -- test builds only: ICE diagnostics, no tokens or secrets
      sessionStorage.setItem(key, JSON.stringify(diag.filter((l) => !l.startsWith('prev: ')).slice(-150)));
    } catch {
      /* ignore */
    }
  });
}

/** For tests: the store to use instead of IndexedDB, and a reset between cases. */
export function setProgressStoreForTests(s: ProgressStore | null): void {
  progress = s;
  keepAwake = null;
  for (const c of receivers.values()) c.dispose();
  for (const c of senders.values()) c.dispose();
  receivers.clear();
  senders.clear();
}

export function receiverFor(sessionId: string, d: Deps): ReceiverController {
  let c = receivers.get(sessionId);
  if (!c) {
    if (!progress) {
      progress = openProgressStore();
      void sweepStorage(progress).catch(() => undefined);
    }
    c = new ReceiverController({
      sessionId,
      api: transfersApi(d.client),
      view: () => d.sessions.get(sessionId),
      socket: d.socket,
      store: progress,
      history: d.history,
      cloud: cloudApi(d.client),
    });
    receivers.set(sessionId, c);
    const rc = c;
    // The literal check lets production builds drop the test-only code entirely.
    if (import.meta.env.VITE_TEST_HOOKS === 'true' && hooks()) keepDiagAcrossLoads(sessionId, rc.diag);
    window.addEventListener('pagehide', () => rc.suspend());
    window.addEventListener('pageshow', (e) => e.persisted && rc.wake());
    keepAwake ??= d.keepAwake ?? null;
    holdWhileActive(c, (s) => rxActive(s.phase));
    const h = hooks();
    if (h) h.receivers[sessionId] = c;
  }
  return c;
}

export function senderFor(sessionId: string, d: Deps): SenderController {
  let c = senders.get(sessionId);
  if (!c) {
    c = new SenderController({
      sessionId,
      api: transfersApi(d.client),
      view: () => d.sessions.get(sessionId),
      socket: d.socket,
      history: d.history,
      files: getOutbox(sessionId),
      ...(cloudChosenFor(sessionId) ? { cloud: cloudApi(d.client) } : {}),
    });
    senders.set(sessionId, c);
    keepAwake ??= d.keepAwake ?? null;
    // Only a tab that still has the picked files can send; after a reload it cannot, so it does not hold.
    holdWhileActive(c, (s) => s.hasFiles && s.receivers.some((r) => txActive(r.status)));
    const h = hooks();
    if (h) h.senders[sessionId] = c;
  }
  return c;
}

function useDeps(): Deps {
  const { client } = useIdentity();
  const { api: sessions, socket } = useSharing();
  const { store: history } = useHistory();
  const keepAwake = useKeepAwakeController();
  return { client, sessions, socket, history, keepAwake };
}

/** The receive controller for a session and its live state; loads on first use when `enabled`. */
export function useReceiver(sessionId: string, enabled = true): [ReceiverController, RxState, boolean] {
  const c = receiverFor(sessionId, useDeps());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (enabled) c.init().catch(() => setFailed(true));
  }, [c, enabled]);
  return [c, useSyncExternalStore(c.subscribe, () => c.state), failed];
}

/** The send controller for a session and its live state; loads on first use when `enabled`. */
export function useSender(sessionId: string, enabled = true): [SenderController, TxState, boolean] {
  const c = senderFor(sessionId, useDeps());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (enabled) c.init().catch(() => setFailed(true));
  }, [c, enabled]);
  return [c, useSyncExternalStore(c.subscribe, () => c.state), failed];
}
