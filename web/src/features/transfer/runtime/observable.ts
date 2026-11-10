/** Minimal external store for React's useSyncExternalStore. */
export class Observable<T> {
  private listeners = new Set<() => void>();
  constructor(protected state_: T) {}

  get state(): T {
    return this.state_;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  protected update(patch: Partial<T> | ((s: T) => T)): void {
    this.state_ = typeof patch === 'function' ? patch(this.state_) : { ...this.state_, ...patch };
    for (const l of this.listeners) l();
  }
}
