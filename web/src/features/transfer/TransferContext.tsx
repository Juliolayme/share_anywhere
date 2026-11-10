import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DeviceClient } from '../../lib/api/device-client';
import { useIdentity } from '../../lib/identity/identity';
import type { SessionSocket } from '../../lib/ws/socket';
import type { HistoryStore } from '../history/store/history-store';
import { useHistory } from '../history/HistoryContext';
import { useSharing } from '../sharing/SharingContext';
import type { sessionsApi } from '../sharing/api';
import { transfersApi } from './runtime/api';
import { getOutbox } from './runtime/outbox';
import { ReceiverController, type RxState } from './runtime/receiver-controller';
import { SenderController, type TxState } from './runtime/sender-controller';
import { openProgressStore, type ProgressStore } from './storage/progress-store';
import { sweepStorage } from './storage/sweep';

/**
 * One controller per session for the life of the tab (module scope, so this code ships only with the lazily
 * loaded session screens), so a transfer survives navigation between the session, dashboard, and history.
 */
const receivers = new Map<string, ReceiverController>();
const senders = new Map<string, SenderController>();
let progress: ProgressStore | null = null;

interface Deps {
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

/** For tests: the store to use instead of IndexedDB, and a reset between cases. */
export function setProgressStoreForTests(s: ProgressStore | null): void {
  progress = s;
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
    });
    receivers.set(sessionId, c);
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
    });
    senders.set(sessionId, c);
    const h = hooks();
    if (h) h.senders[sessionId] = c;
  }
  return c;
}

function useDeps(): Deps {
  const { client } = useIdentity();
  const { api: sessions, socket } = useSharing();
  const { store: history } = useHistory();
  return { client, sessions, socket, history };
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
