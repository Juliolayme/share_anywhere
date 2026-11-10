// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every Tailwind theme scale (spacing, colors, font sizes, radius, shadows, breakpoints) is replaced by the
// design tokens in tailwind.config.ts, so a stock utility such as `gap-5`, `h-px`, `md:flex` or an opacity
// modifier on a CSS-variable color silently generates no CSS. Ask Tailwind itself: any candidate whose
// utility root exists but that Tailwind cannot order (no rule generated) is a bug.
const WEB = new URL('../..', import.meta.url).pathname;
const SRC = join(WEB, 'src');
const req = createRequire(join(WEB, 'package.json'));

const { loadConfig } = req('tailwindcss/lib/lib/load-config');
const resolveConfig = req('tailwindcss/resolveConfig');
const { createContext } = req('tailwindcss/lib/lib/setupContextUtils');
const { defaultExtractor } = req('tailwindcss/lib/lib/defaultExtractor');

interface TwContext {
  candidateRuleMap: Map<string, unknown>;
  getClassOrder(classes: string[]): [string, bigint | null][];
}
// Token names, not class strings.
const SKIP = new Set(['styles/tokens.ts', 'lib/api/schema.gen.ts']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe('Tailwind utilities', () => {
  const ctx = createContext(resolveConfig(loadConfig(join(WEB, 'tailwind.config.ts')))) as TwContext;

  const extract = defaultExtractor(ctx) as (src: string) => string[];
  const roots = new Set(ctx.candidateRuleMap.keys());
  const utilityRoot = (c: string) => {
    const base = (c.split(':').pop() ?? '').replace(/^[!-]+/, '');
    const parts = base.split('-');
    for (let i = parts.length; i > 0; i--) if (roots.has(parts.slice(0, i).join('-'))) return true;
    return false;
  };

  it('every class-like candidate generates CSS with the token-only theme', () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      if (SKIP.has(rel)) continue;
      const candidates = [...new Set(extract(readFileSync(f, 'utf8')))].filter(
        (c) => /[-/]/.test(c) && !/[-/:]$/.test(c) && /^[!a-z0-9-][\w\-:/.[\]#%(),]*$/i.test(c) && utilityRoot(c),
      );
      for (const [c, order] of ctx.getClassOrder(candidates)) if (order === null) bad.push(`${rel}: ${c}`);
    }
    expect(bad).toEqual([]);
  });

  it('the check catches undefined utilities', () => {
    const order = ctx.getClassOrder(['gap-5', 'h-px', 'bg-warning-soft/40', 'md:flex', 'gap-4', 'p-[20px]']);
    expect(order.map(([c, o]) => [c, o !== null])).toEqual([
      ['gap-5', false],
      ['h-px', false],
      ['bg-warning-soft/40', false],
      ['md:flex', false],
      ['gap-4', true],
      ['p-[20px]', true],
    ]);
  });
});
