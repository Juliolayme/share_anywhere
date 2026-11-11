// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Structural guard for PRD §5.9 (guests make no clipboard call): the browser clipboard is touched in one module, which
// only the runtime imports, and the runtime is only ever loaded with a dynamic import by the provider once the account
// is ready on this device.
const SRC = new URL('../..', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

/** Source without comments, so prose about the clipboard does not count. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// User-initiated Copy buttons outside Clipboard Sync (share code and link, pairing code): writeText from a click.
const COPY_BUTTONS = new Set(['pages/send/SessionPage.tsx', 'pages/account/PairPage.tsx']);

describe('clipboard access is confined to the capture module', () => {
  it('only features/clipboard/capture.ts reads the clipboard, queries its permission, or listens to copy events', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      if (rel === 'features/clipboard/capture.ts') continue;
      const src = code(readFileSync(f, 'utf8'));
      if (
        /permissions\s*\.\s*query|addEventListener\(\s*['"](copy|paste)['"]|readText|clipboard\s*\.\s*read\b/.test(src)
      )
        offenders.push(rel);
      if (/navigator\s*\.\s*clipboard/.test(src) && !COPY_BUTTONS.has(rel)) offenders.push(rel);
      if (COPY_BUTTONS.has(rel) && /navigator\s*\.\s*clipboard\s*\.\s*(?!writeText)\w+/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('only the runtime imports the capture module (other imports are type-only)', () => {
    const importers: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      for (const m of code(readFileSync(f, 'utf8')).matchAll(/import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g)) {
        if (m[1] || !/(^|\/)capture$/.test(m[2] ?? '')) continue;
        importers.push(rel);
      }
    }
    expect(importers).toEqual(['features/clipboard/runtime.ts']);
  });

  it('the runtime is loaded only by a dynamic import in ClipboardProvider', () => {
    const staticImporters: string[] = [];
    const dynamicImporters: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      const src = code(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/import\s+(type\s+)?[^;(]*?from\s+['"]([^'"]+)['"]/g))
        if (!m[1] && /(^|\/)runtime$/.test(m[2] ?? '') && rel.startsWith('features/clipboard'))
          staticImporters.push(rel);
      if (
        /import\(\s*['"][^'"]*clipboard\/runtime['"]\s*\)|import\(\s*['"]\.\/runtime['"]\s*\)/.test(src) &&
        rel.includes('clipboard')
      )
        dynamicImporters.push(rel);
    }
    expect(staticImporters).toEqual([]);
    expect(dynamicImporters).toEqual(['features/clipboard/ClipboardContext.tsx']);
  });
});
