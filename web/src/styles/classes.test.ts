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

const ctx = createContext(resolveConfig(loadConfig(join(WEB, 'tailwind.config.ts')))) as TwContext;
const extract = defaultExtractor(ctx) as (src: string) => string[];
const roots = new Set(ctx.candidateRuleMap.keys());
// Single-word utilities whose stock default disappears with the token-only theme (or that only make sense
// with a value), checked even without a dash: `rounded`, `shadow`, ...
const BARE = new Set(['rounded', 'shadow', 'blur', 'drop-shadow', 'ring', 'outline', 'border', 'transition']);

/** True when the candidate looks like a utility: its variant-stripped base starts with a known utility root. */
function utilityLike(candidate: string): boolean {
  const variants = candidate.split(/:(?![^[]*\])/);
  const base = (variants.pop() ?? '').replace(/^[!-]+/, '');
  if (!base || !/^[a-z0-9[]/i.test(base)) return false;
  const hasVariant = variants.length > 0;
  if (!hasVariant && !/[-/]/.test(base) && !BARE.has(base)) return false; // plain words in code
  if (/[-/]$/.test(base)) return false; // template fragments such as `gap-${n}`
  const parts = base.split('-');
  for (let i = parts.length; i > 0; i--) if (roots.has(parts.slice(0, i).join('-'))) return true;
  return false;
}

/** Class-like candidates in a source file that Tailwind generates no CSS for. */
export function undefinedClasses(src: string): string[] {
  const candidates = [...new Set(extract(src))].filter(
    (c) => /^[!a-z0-9[-][\w\-:/.[\]#%(),&>_=+*@!]*$/i.test(c) && !/:$/.test(c) && utilityLike(c),
  );
  return ctx
    .getClassOrder(candidates)
    .filter(([, order]) => order === null)
    .map(([c]) => c);
}

describe('Tailwind utilities', () => {
  it('every class-like candidate in web/src generates CSS with the token-only theme', () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      if (SKIP.has(rel)) continue;
      for (const c of undefinedClasses(readFileSync(f, 'utf8'))) bad.push(`${rel}: ${c}`);
    }
    expect(bad).toEqual([]);
  });

  it('the scan itself catches undefined utilities in a source file', () => {
    const src = `
      import { thing } from './x';
      const delay = 3; // plain words are not classes
      export const A = () => (
        <div className="flex gap-5 h-px bg-warning-soft/40 md:flex sm:block lg:hidden rounded shadow text-sm
          gap-4 p-[20px] rounded-lg shadow-e1 rail:flex sidebar:hidden bg-send-soft text-caption hover:bg-surface-2
          [&>svg]:h-5 [&>svg]:h-[20px] md:!p-5 hover:!gap-4" data-x={\`gap-\${delay}\`} />
      );`;
    expect(undefinedClasses(src).sort()).toEqual(
      [
        '[&>svg]:h-5',
        'bg-warning-soft/40',
        'gap-5',
        'h-px',
        'lg:hidden',
        'md:!p-5',
        'md:flex',
        'rounded',
        'shadow',
        'sm:block',
        'text-sm',
      ].sort(),
    );
  });
});
