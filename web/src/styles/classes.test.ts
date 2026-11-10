// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { space } from './tokens';

// Tailwind's spacing scale is replaced by the design tokens (tailwind.config.ts), so a utility such as
// `gap-5` or `p-5` silently generates no CSS. Fail on any numeric spacing utility outside the token keys.
const SPACING =
  /(?<![\w-])-?(?:p[xytblr]?|m[xytblr]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|bottom|left|right|w|h|min-w|min-h|max-w|max-h|translate-[xy]|scroll-[mp][xytblr]?)-(\d+(?:\.\d+)?)(?![\w./[-])/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe('Tailwind spacing utilities', () => {
  it('only use spacing keys defined by the design tokens', () => {
    const allowed = new Set(['0', 'px', ...Object.keys(space)]);
    const bad: string[] = [];
    for (const f of files(new URL('..', import.meta.url).pathname)) {
      for (const m of readFileSync(f, 'utf8').matchAll(SPACING)) {
        if (!allowed.has(m[1] ?? '')) bad.push(`${f.split('/src/')[1]}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
