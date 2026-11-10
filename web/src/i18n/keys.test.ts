// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as en from './catalog-en';
import * as vi from './catalog-vi';

const SRC = new URL('..', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

function has(catalog: Record<string, unknown>, key: string): boolean {
  let cur: unknown = catalog;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string';
}

describe('string keys used in code', () => {
  it('every literal t("…") key and every catalog-key string resolves in the EN and VI catalogs the Web ships', () => {
    const missing: string[] = [];
    const keyLike =
      /['"`]((?:common|handoff|phrases|product|web|web_patterns|web_vv|web_xx|web_yy)\.[a-z0-9_.]+)['"`]/g;
    for (const f of files(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(keyLike)) {
        const key = m[1] ?? '';
        if (key.endsWith('.')) continue; // prefixes such as `product.save_${mode}_h`
        for (const [name, cat] of [
          ['en', en],
          ['vi', vi],
        ] as const)
          if (!has(cat as unknown as Record<string, unknown>, key))
            missing.push(`${relative(SRC, f)}: ${key} (${name})`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
