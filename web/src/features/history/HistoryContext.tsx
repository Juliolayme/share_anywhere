import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { openHistoryStore, type HistoryEntry, type HistoryStore } from './store/history-store';
import { getRetention } from '../../lib/prefs';

/** Cloud history sync listens to local deletions (Phase 5A); the local operation never waits for it. */
export interface HistorySyncHandler {
  removed: (ids: string[]) => void;
  cleared: () => void;
}

interface HistoryValue {
  entries: HistoryEntry[];
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
  /** Deletes one entry (HI-2 "Delete from history"). */
  remove: (id: string) => Promise<void>;
  store: HistoryStore | null;
  /** Registers the account's sync handler (null to remove it). */
  setSyncHandler: (h: HistorySyncHandler | null) => void;
}

const HistoryContext = createContext<HistoryValue | null>(null);

function tryOpen(): HistoryStore | null {
  try {
    return typeof indexedDB === 'undefined' ? null : openHistoryStore();
  } catch {
    return null;
  }
}

export function HistoryProvider({ children, store: given }: { children: ReactNode; store?: HistoryStore | null }) {
  const [store] = useState<HistoryStore | null>(() => (given === undefined ? tryOpen() : given));
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(store === null);
  const sync = useRef<HistorySyncHandler | null>(null);
  const setSyncHandler = useCallback((h: HistorySyncHandler | null) => {
    sync.current = h;
  }, []);

  const refresh = useCallback(async () => {
    if (!store) return;
    try {
      await store.sweep(getRetention());
      setEntries(await store.list());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [store]);

  const clear = useCallback(async () => {
    if (!store) return;
    await store.clear();
    setEntries([]);
    sync.current?.cleared();
  }, [store]);

  const remove = useCallback(
    async (id: string) => {
      if (!store) return;
      await store.remove(id);
      setEntries((list) => list.filter((e) => e.id !== id));
      sync.current?.removed([id]);
    },
    [store],
  );

  useEffect(() => {
    if (store) void refresh();
    else setLoading(false);
  }, [store, refresh]);

  const value = useMemo(
    () => ({ entries, loading, error, refresh, clear, remove, store, setSyncHandler }),
    [entries, loading, error, refresh, clear, remove, store, setSyncHandler],
  );
  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>;
}

export function useHistory(): HistoryValue {
  const v = useContext(HistoryContext);
  if (!v) throw new Error('useHistory outside HistoryProvider');
  return v;
}
