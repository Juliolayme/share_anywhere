// Keep-awake controller for the Web (docs/ARCHITECTURE.md §7). One instance per tab decides whether to hold
// a Screen Wake Lock from the app state, and reports the screen-on pill state (§7.3).

export type PillState = 'on' | 'off' | 'paused' | 'setoff' | 'unsupported' | 'refused';

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: 'release', fn: () => void): void;
  released?: boolean;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<Sentinel>;
}

export interface KeepAwakeEnv {
  wakeLock?: WakeLockLike | undefined;
  isSecure: boolean;
  isVisible: () => boolean;
  onVisibility: (fn: () => void) => () => void;
}

export function browserEnv(): KeepAwakeEnv {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: WakeLockLike }) : undefined;
  return {
    wakeLock: nav?.wakeLock,
    isSecure: typeof window !== 'undefined' ? window.isSecureContext : false,
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onVisibility: (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
  };
}

export class KeepAwakeController {
  private active = false;
  private settingOn = true;
  private userOff = false;
  private sentinel: Sentinel | null = null;
  private requesting = false;
  private refused = false;
  private listeners = new Set<(s: PillState) => void>();
  private unsubVisibility: () => void;

  constructor(private readonly env: KeepAwakeEnv) {
    this.unsubVisibility = env.onVisibility(() => {
      // The browser releases the lock when the tab is hidden; ask again when it is visible and still active.
      if (env.isVisible()) void this.sync();
    });
  }

  get supported(): boolean {
    return !!this.env.wakeLock && this.env.isSecure;
  }

  get state(): PillState {
    if (!this.settingOn) return 'setoff';
    if (!this.active) return 'paused';
    if (this.userOff) return 'off';
    if (!this.supported) return 'unsupported';
    if (this.refused) return 'refused';
    return 'on';
  }

  /** True when the app should warn before the tab closes (beforeunload). */
  get engaged(): boolean {
    return this.active;
  }

  subscribe(fn: (s: PillState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l(this.state);
  }

  /** Something that needs the screen on started (true) or ended (false). Ending resets the user's choice. */
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (!active) this.userOff = false;
    void this.sync();
  }

  setSetting(on: boolean) {
    this.settingOn = on;
    void this.sync();
  }

  /** Pill tap: on ↔ off for this transfer, retry when refused, turn the setting back on when off in Settings. */
  tap(): 'setting' | undefined {
    const s = this.state;
    if (s === 'setoff') return 'setting';
    if (s === 'refused') {
      this.refused = false;
      void this.sync();
    } else if (s === 'on' || s === 'off') {
      this.userOff = s === 'on';
      void this.sync();
    }
    return undefined;
  }

  private want(): boolean {
    return this.active && this.settingOn && !this.userOff && this.supported;
  }

  private async sync() {
    const wakeLock = this.env.wakeLock;
    if (wakeLock && this.want() && this.env.isVisible()) {
      if (!this.sentinel && !this.requesting && !this.refused) {
        this.requesting = true;
        try {
          const s = await wakeLock.request('screen');
          this.requesting = false;
          if (!this.want()) {
            await s.release();
          } else {
            this.sentinel = s;
            s.addEventListener('release', () => {
              if (this.sentinel === s) this.sentinel = null;
              this.emit();
            });
          }
        } catch {
          this.requesting = false;
          this.refused = true; // NotAllowedError: battery saver, policy, hidden tab
        }
      }
    } else if (this.sentinel && !this.want()) {
      const s = this.sentinel;
      this.sentinel = null;
      await s.release().catch(() => undefined);
    }
    this.emit();
  }

  dispose() {
    this.unsubVisibility();
    this.active = false;
    void this.sync();
  }
}
