import type { DeviceClient } from '../api/device-client';

export interface SocketEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (e: SocketEvent) => void;

export interface SocketOptions {
  /** Creates a WebSocket; injectable for tests. */
  create?: (url: string) => WebSocket;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  location?: { protocol: string; host: string };
}

/**
 * One WebSocket per tab (docs/API.md §4): fetches a one-time ticket, connects, dispatches events, and
 * reconnects with backoff while anything is subscribed. Signaling messages are sent through `send`.
 */
export class SessionSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private attempt = 0;
  private timer: unknown = null;
  private stopped = true;
  connected = false;
  private readonly opts: Required<SocketOptions>;

  constructor(
    private readonly client: DeviceClient,
    opts: SocketOptions = {},
  ) {
    this.opts = {
      create: opts.create ?? ((url) => new WebSocket(url)),
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      location: opts.location ?? window.location,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.stopped) {
      this.stopped = false;
      void this.open();
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private emit(e: SocketEvent) {
    for (const l of this.listeners) l(e);
  }

  private async open() {
    if (this.stopped) return;
    try {
      const { ticket } = await this.client.request<{ ticket: string }>('POST', '/v1/ws/ticket');
      if (this.stopped) return;
      const { protocol, host } = this.opts.location;
      const ws = this.opts.create(
        `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/v1/ws?ticket=${encodeURIComponent(ticket)}`,
      );
      this.ws = ws;
      ws.onopen = () => {
        this.attempt = 0;
      };
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(String(m.data)) as SocketEvent;
          if (e.type === 'WELCOME') {
            this.connected = true;
            this.emit({ type: 'SOCKET_OPEN' });
          }
          this.emit(e);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        this.ws = null;
        if (this.connected) {
          this.connected = false;
          this.emit({ type: 'SOCKET_CLOSED' });
        }
        this.retry();
      };
    } catch {
      this.retry();
    }
  }

  private retry() {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.timer = this.opts.setTimer(() => void this.open(), delay);
  }

  /** Sends a client message (signaling). Returns false when the socket is not open. */
  send(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.opts.clearTimer(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    ws?.close();
  }
}
