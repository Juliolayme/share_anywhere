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

test('Kotlin models: required, optional and nullable fields, allOf merges, aliases, maps, operations', async () => {
  const { renderKotlinModels } = await import('./protocol.mjs');
  const doc = {
    info: { version: '9.9.9' },
    paths: {
      '/v1/things/{id}': { post: { operationId: 'makeThing', 'x-sa-access': 'device', summary: 'Make it.' } },
    },
    components: {
      schemas: {
        Base64Url: { type: 'string' },
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, retry_after_s: { type: 'integer' } } },
        Thing: {
          type: 'object',
          required: ['id', 'size', 'tags', 'when'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            size: { type: 'integer', format: 'int64' },
            tags: { type: 'array', items: { type: 'string' } },
            when: { type: 'string', nullable: true },
            kind: { type: 'string', enum: ['a', 'b'] },
            checks: { type: 'object', additionalProperties: { type: 'string' } },
            blob: { allOf: [{ $ref: '#/components/schemas/Base64Url' }] },
            inner: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
        ThingError: { allOf: [{ $ref: '#/components/schemas/Error' }, { type: 'object', required: ['thing'], properties: { thing: { $ref: '#/components/schemas/Thing' } } }] },
      },
    },
  };
  const kt = renderKotlinModels(doc);
  assert.ok(kt.includes('const val API_VERSION = "9.9.9"'));
  assert.ok(kt.includes('typealias Base64Url = String'));
  assert.ok(kt.includes('@SerialName("id") val id: String,'));
  assert.ok(kt.includes('@SerialName("size") val size: Long,'));
  assert.ok(kt.includes('@SerialName("tags") val tags: List<String>,'));
  assert.ok(kt.includes('@SerialName("when") val `when`: String? = null,'));
  assert.ok(kt.includes('One of: a, b.'));
  assert.ok(kt.includes('@SerialName("checks") val checks: Map<String, String>? = null,'));
  assert.ok(kt.includes('@SerialName("blob") val blob: Base64Url? = null,'));
  assert.ok(kt.includes('@SerialName("inner") val inner: ThingInner? = null,'));
  assert.ok(kt.includes('data class ThingInner('));
  assert.ok(kt.includes('data class ThingError(\n    @SerialName("error") val error: String,\n    @SerialName("retry_after_s") val retryAfterS: Int? = null,\n    @SerialName("thing") val thing: Thing,\n)'));
  assert.ok(kt.includes('val makeThing = ApiOperation("POST", "/v1/things/{id}", "device")'));
  assert.ok(kt.includes('val all: List<ApiOperation> = listOf(makeThing)'));
  assert.ok(!kt.includes('import kotlinx.serialization.json.JsonElement'));
});

test('renderSwiftModels writes Codable structs, typealiases and the operation table for the iOS client', async () => {
  const { renderSwiftModels } = await import('./protocol.mjs');
  const doc = {
    info: { version: '9.9.9' },
    paths: { '/v1/things/{id}': { post: { operationId: 'makeThing', 'x-sa-access': 'device', summary: 'Make it.' } } },
    components: {
      schemas: {
        Base64Url: { type: 'string' },
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, retry_after_s: { type: 'integer' } } },
        Thing: {
          type: 'object',
          required: ['id', 'size', 'tags'],
          properties: {
            id: { type: 'string' },
            size: { type: 'integer', format: 'int64' },
            tags: { type: 'array', items: { type: 'string' } },
            default: { type: 'boolean' },
            checks: { type: 'object', additionalProperties: { type: 'string' } },
            err: { $ref: '#/components/schemas/Error' },
            inner: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
      },
    },
  };
  const sw = renderSwiftModels(doc);
  assert.ok(sw.includes('public let apiVersion = "9.9.9"'));
  assert.ok(sw.includes('public typealias Base64Url = String'));
  assert.ok(sw.includes('public struct ErrorResponse: Codable, Sendable, Equatable {'), 'Error is renamed so it does not shadow Swift.Error');
  assert.ok(sw.includes('    public var size: Int64\n'));
  assert.ok(sw.includes('    public var tags: [String]\n'));
  assert.ok(sw.includes('    public var `default`: Bool?\n'));
  assert.ok(sw.includes('        case `default` = "default"'));
  assert.ok(sw.includes('    public var checks: [String: String]?\n'));
  assert.ok(sw.includes('    public var err: ErrorResponse?\n'));
  assert.ok(sw.includes('public struct ThingInner: Codable, Sendable, Equatable {'));
  assert.ok(sw.includes('        case retryAfterS = "retry_after_s"'));
  assert.ok(sw.includes('public static let makeThing = APIOperation(method: "POST", path: "/v1/things/{id}", access: "device")'));
  assert.ok(sw.includes('public static let all: [APIOperation] = [makeThing]'));
});
