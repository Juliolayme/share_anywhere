#!/usr/bin/env node
// Phase 5B CI guard (docs/phases/PHASE_5_ACCOUNTS_CLIPBOARD.md "CI changes", CLAUDE.md §7): key material and tokens
// never touch Web Storage. Fails when
//   1. any file under web/src/lib/crypto (key handling) or web/src/features/clipboard (clipboard content) mentions
//      localStorage, sessionStorage, or document.cookie, or
//   2. any Web code reads or writes Web Storage (directly or through src/lib/storage.ts readPref/writePref) under a key
//      that names a token, secret, refresh secret, password, private key, or the account key (ADK).
// Usage: node scripts/check-storage.mjs [root]   (exit 1 with the offending lines)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const STORAGE = /\b(localStorage|sessionStorage|document\.cookie)\b/;
const SENSITIVE_KEY =
  /\b(?:(?:local|session)Storage\s*\.\s*(?:setItem|getItem|removeItem)|(?:readPref|writePref|removePref))\s*\(\s*[`'"][^`'"]*(token|secret|refresh|password|passphrase|private|adk|recovery)/i;

/** All .ts/.tsx/.js files under dir (missing dirs give none). */
function files(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

export function check(rootDir) {
  const w = join(rootDir, 'web', 'src');
  const banned = [join(w, 'lib', 'crypto'), join(w, 'features', 'clipboard')];
  const problems = [];
  for (const f of files(w)) {
    const lines = readFileSync(f, 'utf8').split('\n');
    const inBanned = banned.some((d) => f.startsWith(d + '/'));
    lines.forEach((line, i) => {
      const where = `${relative(rootDir, f)}:${i + 1}`;
      if (inBanned && STORAGE.test(line)) problems.push(`${where}: Web Storage or cookies in key/clipboard code: ${line.trim()}`);
      if (SENSITIVE_KEY.test(line)) problems.push(`${where}: Web Storage key names a secret: ${line.trim()}`);
    });
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = check(root);
  if (problems.length) {
    console.error(`storage guard: ${problems.length} problem(s)\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('storage guard: no Web Storage in key or clipboard code, no secret-named storage keys');
}
