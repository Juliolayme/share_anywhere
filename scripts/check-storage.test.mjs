import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { check } from './check-storage.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'sa-storage-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test('passes clean code, including prefs with harmless keys', () => {
  const root = tree({
    'web/src/lib/crypto/adk.ts': 'export const x = 1;\n',
    'web/src/lib/storage.ts': 'window.localStorage.getItem(PREFIX + key);\n',
    'web/src/features/history/a.ts': "writePref('history.removed', '[]');\n",
  });
  assert.deepEqual(check(root), []);
});

test('flags Web Storage or cookies in crypto and clipboard code', () => {
  const root = tree({
    'web/src/lib/crypto/store.ts': "localStorage.setItem('x', y);\n",
    'web/src/features/clipboard/queue.ts': 'document.cookie = "a=b";\n',
  });
  assert.equal(check(root).length, 2);
});

test('flags secret-named storage keys anywhere', () => {
  const root = tree({
    'web/src/app/a.ts': "localStorage.setItem('access_token', t);\n",
    'web/src/app/b.ts': "writePref('account.adk', raw);\n",
    'web/src/app/c.ts': "sessionStorage.getItem(`refreshSecret`);\n",
  });
  assert.equal(check(root).length, 3);
});
