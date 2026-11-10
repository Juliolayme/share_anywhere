import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { apiMdEndpoints, compare, openapiOperations } from './protocol.mjs';

const md = `
## 2. Endpoints
### 2.1 Health (Phase 1)
| Endpoint | Level | Notes |
|---|---|---|
| \`GET /a\`, \`PATCH /a\` | device | x |
| \`POST /t/{id}/pause\`, \`/resume\` | participant (sender) | |
| \`GET /v1/ws?ticket=\` | public (one-time ticket) | |
### 2.2 Later (Phase 2)
| \`/v1/keys/*\` | account+device | |
| \`POST /later\` | device | |
## 3. Errors
| \`device_token_invalid\` | x |
`;

test('API.md rows are parsed with continuation paths, query strings, and level words', () => {
  const rows = apiMdEndpoints(md);
  const keys = rows.filter((r) => !r.pattern).map((r) => `${r.key}=${r.access}@${r.section}`);
  assert.deepEqual(keys, [
    'GET /a=device@2.1',
    'PATCH /a=device@2.1',
    'POST /t/{id}/pause=participant@2.1',
    'POST /t/{id}/resume=participant@2.1',
    'GET /v1/ws=public@2.1',
    'POST /later=device@2.2',
  ]);
});

test('compare reports level mismatches, missing rows, and uncovered sections', () => {
  const rows = apiMdEndpoints(md);
  const ops = [
    { key: 'GET /a', access: 'device' },
    { key: 'PATCH /a', access: 'public' },
    { key: 'GET /v1/ws', access: 'public' },
    { key: 'POST /t/{id}/pause', access: 'participant' },
    { key: 'DELETE /nowhere', access: 'device' },
    { key: 'POST /later', access: 'admin' },
  ];
  const problems = compare(ops, rows, ['2.1']);
  assert.ok(problems.some((p) => p.includes('PATCH /a: openapi.yaml says public')));
  assert.ok(problems.some((p) => p.includes('DELETE /nowhere: in openapi.yaml but not')));
  assert.ok(problems.some((p) => p.includes('POST /t/{id}/resume: docs/API.md §2.1 lists it')));
  assert.ok(problems.some((p) => p.includes('POST /later: x-sa-access is "admin"')));
  assert.ok(!problems.some((p) => p.startsWith('GET /a')));
});

test('every operation in the real openapi.yaml declares a known x-sa-access', () => {
  const doc = YAML.parse(readFileSync(new URL('../shared/protocol/openapi.yaml', import.meta.url), 'utf8'));
  for (const op of openapiOperations(doc)) {
    assert.ok(['public', 'device', 'participant', 'account', 'account+device'].includes(op.access), op.key);
  }
});
