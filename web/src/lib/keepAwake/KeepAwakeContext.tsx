import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { browserEnv, KeepAwakeController, type KeepAwakeEnv, type PillState } from './controller';
import { readPref, writePref } from '../storage';

const KeepAwakeContext = createContext<KeepAwakeController | null>(null);

export function getKeepScreenOnSetting(): boolean {
  return readPref('keepScreenOn') !== '0';
}

export function KeepAwakeProvider({ children, env }: { children: ReactNode; env?: KeepAwakeEnv }) {
  const [controller] = useState(() => {
    const c = new KeepAwakeController(env ?? browserEnv());
    c.setSetting(getKeepScreenOnSetting());
    return c;
  });
  useEffect(() => {
    // Ask before the tab closes while something needs it open (docs/ARCHITECTURE.md §7.3).
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!controller.engaged) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      controller.dispose();
    };
  }, [controller]);
  return <KeepAwakeContext.Provider value={controller}>{children}</KeepAwakeContext.Provider>;
}

export function useKeepAwakeController(): KeepAwakeController {
  const c = useContext(KeepAwakeContext);
  if (!c) throw new Error('useKeepAwakeController outside KeepAwakeProvider');
  return c;
}

/** Marks this screen as needing the screen on while `active` is true. */
export function useKeepAwake(active: boolean): PillState {
  const c = useKeepAwakeController();
  const [holder] = useState(() => Symbol('keep-awake holder'));
  useEffect(() => {
    c.hold(holder, active);
    return () => c.hold(holder, false);
  }, [c, holder, active]);
  return useSyncExternalStore(
    (cb) => c.subscribe(cb),
    () => c.state,
    () => c.state,
  );
}

/** The Settings switch "Keep screen on during transfers" (default on, stored per device). */
export function useKeepScreenOnSetting(): [boolean, (on: boolean) => void] {
  const c = useKeepAwakeController();
  const [on, setOn] = useState(getKeepScreenOnSetting);
  const set = useMemo(
    () => (v: boolean) => {
      writePref('keepScreenOn', v ? '1' : '0');
      c.setSetting(v);
      setOn(v);
    },
    [c],
  );
  return [on, set];
}
