import { useCallback, useState } from 'react';
import { readPref, writePref } from './storage';
import type { Retention } from '../features/history/store/history-store';

// UI preferences kept in Web Storage through storage.ts (never tokens or secrets).

export function getRetention(): Retention {
  const v = readPref('historyRetention');
  return v === '90' || v === 'none' ? v : '30';
}

export function hasSeenWelcome(): boolean {
  return readPref('welcomed') === '1';
}

export function markWelcomeSeen(): void {
  writePref('welcomed', '1');
}

export function useRetention(): [Retention, (r: Retention) => void] {
  const [value, setValue] = useState<Retention>(getRetention);
  const set = useCallback((r: Retention) => {
    writePref('historyRetention', r);
    setValue(r);
  }, []);
  return [value, set];
}
