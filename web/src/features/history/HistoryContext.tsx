import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { openHistoryStore, type HistoryEntry, type HistoryStore } from './store/history-store';
import { getRetention } from '../../lib/prefs';

interface HistoryValue {
  entries: HistoryEntry[];
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
  /** Deletes one entry (HI-2 "Delete from history"). */
  remove: (id: string) => Promise<void>;
  store: HistoryStore | null;
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
  }, [store]);

  const remove = useCallback(
    async (id: string) => {
      if (!store) return;
      await store.remove(id);
      setEntries((list) => list.filter((e) => e.id !== id));
    },
    [store],
  );

  useEffect(() => {
    if (store) void refresh();
    else setLoading(false);
  }, [store, refresh]);

  const value = useMemo(
    () => ({ entries, loading, error, refresh, clear, remove, store }),
    [entries, loading, error, refresh, clear, remove, store],
  );
  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>;
}

export function useHistory(): HistoryValue {
  const v = useContext(HistoryContext);
  if (!v) throw new Error('useHistory outside HistoryProvider');
  return v;
}
