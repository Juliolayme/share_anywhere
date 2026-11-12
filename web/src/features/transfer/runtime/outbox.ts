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
  cloudChosen.delete(sessionId);
}

/** Sessions created with Cloud transfer chosen (after the consent dialog), in this tab's memory like the files. */
const cloudChosen = new Set<string>();

export function chooseCloud(sessionId: string): void {
  cloudChosen.add(sessionId);
}

export function cloudChosenFor(sessionId: string): boolean {
  return cloudChosen.has(sessionId);
}
