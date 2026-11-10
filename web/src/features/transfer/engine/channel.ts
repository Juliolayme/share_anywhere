/** The slice of RTCDataChannel the engine uses, so tests can run it over an in-memory pair. */
export interface Channel {
  send(data: ArrayBuffer): void;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onbufferedamountlow: (() => void) | null;
  onmessage: ((data: ArrayBuffer) => void) | null;
  onclose: (() => void) | null;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  /** Largest message the peer accepts (RTCSctpTransport.maxMessageSize); undefined when unknown. */
  readonly maxMessageSize?: number | undefined;
  close(): void;
}

/** Wraps an RTCDataChannel (binaryType arraybuffer). */
export function fromDataChannel(dc: RTCDataChannel, pc?: RTCPeerConnection): Channel {
  dc.binaryType = 'arraybuffer';
  const ch: Channel = {
    send: (data) => dc.send(data),
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(v: number) {
      dc.bufferedAmountLowThreshold = v;
    },
    onbufferedamountlow: null,
    onmessage: null,
    onclose: null,
    get readyState() {
      return dc.readyState;
    },
    get maxMessageSize() {
      return pc?.sctp?.maxMessageSize ?? undefined;
    },
    close: () => dc.close(),
  };
  dc.onbufferedamountlow = () => ch.onbufferedamountlow?.();
  dc.onmessage = (e: MessageEvent) => {
    if (e.data instanceof ArrayBuffer) ch.onmessage?.(e.data);
  };
  dc.onclose = () => ch.onclose?.();
  return ch;
}

/** Resolves once bufferedAmount drops to the low threshold (or the channel closes). */
export function drained(ch: Channel): Promise<void> {
  if (ch.bufferedAmount <= ch.bufferedAmountLowThreshold || ch.readyState !== 'open') return Promise.resolve();
  return new Promise((resolve) => {
    const prevLow = ch.onbufferedamountlow;
    const prevClose = ch.onclose;
    const done = () => {
      ch.onbufferedamountlow = prevLow;
      ch.onclose = prevClose;
      resolve();
    };
    ch.onbufferedamountlow = () => {
      prevLow?.();
      done();
    };
    ch.onclose = () => {
      prevClose?.();
      done();
    };
  });
}
