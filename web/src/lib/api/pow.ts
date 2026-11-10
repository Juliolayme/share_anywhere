/** Leading zero bits of a SHA-256 digest. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/**
 * Solves the device-creation proof-of-work: finds `solution` so SHA-256(token + ":" + solution) starts
 * with `difficulty` zero bits (docs/ADR/0008-device-token-format.md). Yields to the event loop between
 * batches so the page stays responsive; difficulty 16 takes about 65,000 hashes on average.
 */
export async function solvePow(token: string, difficulty: number, signal?: AbortSignal): Promise<string> {
  const enc = new TextEncoder();
  for (let i = 0; ; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const solution = i.toString(36);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${token}:${solution}`)));
    if (leadingZeroBits(digest) >= difficulty) return solution;
    if (i % 2048 === 2047) await new Promise((r) => setTimeout(r, 0));
  }
}
