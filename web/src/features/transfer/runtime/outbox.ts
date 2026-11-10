/**
 * The sender's chosen files, kept in this tab's memory for the life of the session. They are never uploaded;
 * a reload loses them (the browser gives no persistent access to picked files), which the session screen
 * explains (docs/TRANSFER_PROTOCOL.md §6).
 */
const outbox = new Map<string, File[]>();

export function putOutbox(sessionId: string, files: File[]): void {
  outbox.set(sessionId, files);
}

export function getOutbox(sessionId: string): File[] | undefined {
  return outbox.get(sessionId);
}

export function dropOutbox(sessionId: string): void {
  outbox.delete(sessionId);
}
