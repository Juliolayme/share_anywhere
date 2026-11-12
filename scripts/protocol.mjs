#!/usr/bin/env node
// Protocol contract tooling (docs/TESTING_AND_CI.md, CLAUDE.md §7):
//   node scripts/protocol.mjs          regenerate web/src/lib/api/schema.gen.ts and the Android models
//                                      (android/app/src/main/java/app/shareanywhere/data/api/Api.gen.kt)
//   node scripts/protocol.mjs --check  validate openapi.yaml, x-sa-access on every operation,
//                                      agreement with docs/API.md, the WebSocket schema, and that
//                                      generated clients (TypeScript, Kotlin, Swift) are current.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import openapiTS, { astToString } from 'openapi-typescript';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENAPI = path.join(root, 'shared/protocol/openapi.yaml');
const WS_SCHEMA = path.join(root, 'shared/protocol/websocket-events.json');
const API_MD = path.join(root, 'docs/API.md');
const TS_OUT = path.join(root, 'web/src/lib/api/schema.gen.ts');
const KT_OUT = path.join(root, 'android/app/src/main/java/app/shareanywhere/data/api/Api.gen.kt');
const SWIFT_OUT = path.join(root, 'ios/ShareAnywhereCore/Sources/SAAPIClient/API.gen.swift');

export const LEVELS = ['public', 'device', 'participant', 'account', 'account+device'];
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

/** Operations in an OpenAPI document as {key: "METHOD /path", access}. */
export function openapiOperations(doc) {
  const ops = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) {
      if (item[m]) ops.push({ key: `${m.toUpperCase()} ${p}`, access: item[m]['x-sa-access'], op: item[m] });
    }
  }
  return ops;
}

/**
 * Endpoint rows of docs/API.md §2 as [{key, access, section}]. A cell may list several endpoints
 * ("`GET /a`, `PATCH /a`") or continue the previous path ("`POST /t/{id}/pause`, `/resume`").
 * The level is the first word of the second column ("participant (sender)" → participant).
 */
export function apiMdEndpoints(md) {
  const rows = [];
  let section = null;
  for (const line of md.split('\n')) {
    const h = line.match(/^### (\d+\.\d+) /);
    if (h) section = h[1];
    else if (line.startsWith('## ')) section = null;
    if (!section || !line.startsWith('| `')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const access = (cells[2] || '').split(/\s/)[0];
    let method = null;
    let base = null;
    for (const [, code] of cells[1].matchAll(/`([^`]+)`/g)) {
      const full = code.match(/^(GET|POST|PUT|PATCH|DELETE) (\S+)$/);
      if (full) {
        method = full[1];
        base = full[2];
        rows.push({ key: `${method} ${base.split('?')[0]}`, access, section });
      } else if (code.startsWith('/') && method && base) {
        const parent = base.replace(/\/[^/]+$/, '');
        rows.push({ key: `${method} ${parent}${code}`, access, section });
      } else {
        rows.push({ key: code, access, section, pattern: true });
      }
    }
  }
  return rows;
}

/** Problems between the two lists; `sections` are the docs/API.md sections openapi.yaml must cover. */
export function compare(ops, rows, sections) {
  const problems = [];
  const byKey = new Map(rows.filter((r) => !r.pattern).map((r) => [r.key, r]));
  for (const o of ops) {
    if (!LEVELS.includes(o.access)) problems.push(`${o.key}: x-sa-access is ${JSON.stringify(o.access)}`);
    const r = byKey.get(o.key);
    if (!r) problems.push(`${o.key}: in openapi.yaml but not in docs/API.md §2`);
    else if (r.access !== o.access) problems.push(`${o.key}: openapi.yaml says ${o.access}, docs/API.md says ${r.access}`);
  }
  const opKeys = new Set(ops.map((o) => o.key));
  for (const r of rows) {
    if (sections.includes(r.section) && !r.pattern && !opKeys.has(r.key)) {
      problems.push(`${r.key}: docs/API.md §${r.section} lists it but openapi.yaml does not`);
    }
  }
  return problems;
}


// ---------------------------------------------------------------------------------------------------------
// Kotlin models for the Android client (docs/ADR/0016-android-networking.md): one @Serializable data class per
// object schema, typealiases for primitive schemas, and ApiOperations with every operation's method, path and
// access level. Enums stay String (with the allowed values in KDoc) so a new server value never breaks decoding.

const KOTLIN_KEYWORDS = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while']);

const camel = (s) => s.replace(/[-_ ]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
const pascalCase = (s) => camel(s).replace(/^./, (c) => c.toUpperCase());
const ktProp = (name) => {
  const c = camel(name);
  return KOTLIN_KEYWORDS.has(c) ? `\`${c}\`` : c;
};
const refName = (ref) => ref.replace('#/components/schemas/', '');
const kdoc = (text, indent) => {
  if (!text) return [];
  const clean = String(text).replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
  return [`${indent}/** ${clean} */`];
};

/** Kotlin type of a property schema; nested inline objects are added to `extra` as classes named `hint`. */
function ktType(schema, hint, extra, schemas) {
  if (!schema) return 'JsonElement';
  if (schema.$ref) return refName(schema.$ref);
  if (schema.allOf && schema.allOf.length === 1) return ktType(schema.allOf[0], hint, extra, schemas);
  if (schema.allOf || schema.oneOf || schema.anyOf) {
    if (schema.allOf) {
      extra.push([hint, schema]);
      return hint;
    }
    return 'JsonElement';
  }
  switch (schema.type) {
    case 'string':
      return 'String';
    case 'integer':
      return schema.format === 'int64' ? 'Long' : 'Int';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Boolean';
    case 'array':
      return `List<${ktType(schema.items, `${hint}Item`, extra, schemas)}>`;
    case 'object':
      if (schema.properties) {
        extra.push([hint, schema]);
        return hint;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return `Map<String, ${ktType(schema.additionalProperties, `${hint}Value`, extra, schemas)}>`;
      }
      return 'JsonObject';
    default:
      return 'JsonElement';
  }
}

/** Properties and required names of an object schema, merging allOf parts (refs resolved). */
function objectShape(schema, schemas, seen = new Set()) {
  const props = {};
  const required = new Set(schema.required ?? []);
  for (const part of schema.allOf ?? []) {
    const resolved = part.$ref ? schemas[refName(part.$ref)] : part;
    if (part.$ref) {
      if (seen.has(part.$ref)) throw new Error(`allOf cycle at ${part.$ref}`);
      seen.add(part.$ref);
    }
    const inner = objectShape(resolved, schemas, seen);
    Object.assign(props, inner.props);
    for (const r of inner.required) required.add(r);
  }
  Object.assign(props, schema.properties ?? {});
  return { props, required };
}

function renderClass(name, schema, schemas, out, description) {
  const extra = [];
  const { props, required } = objectShape(schema, schemas);
  const lines = [...kdoc(description ?? schema.description, '')];
  const entries = Object.entries(props);
  if (!entries.length) {
    lines.push('@Serializable', `class ${name}`);
    out.push(lines.join('\n'));
    return;
  }
  lines.push('@Serializable', `data class ${name}(`);
  for (const [prop, ps] of entries) {
    const type = ktType(ps, `${name}${pascalCase(prop)}`, extra, schemas);
    const optional = !required.has(prop) || ps.nullable === true;
    const doc = [ps.description, ps.enum ? `One of: ${ps.enum.join(', ')}.` : null, ps.format && !['int64'].includes(ps.format) ? `Format: ${ps.format}.` : null]
      .filter(Boolean)
      .join(' ');
    lines.push(...kdoc(doc, '    '));
    lines.push(`    @SerialName("${prop}") val ${ktProp(prop)}: ${type}${optional ? '? = null' : ''},`);
  }
  lines.push(')');
  out.push(lines.join('\n'));
  for (const [n, s] of extra) renderClass(n, s, schemas, out);
}

export function renderKotlinModels(doc) {
  const schemas = doc.components?.schemas ?? {};
  const out = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const isObject = schema.type === 'object' || schema.allOf || schema.properties;
    if (isObject) renderClass(name, schema, schemas, out);
    else {
      const extra = [];
      const type = ktType(schema, `${name}Value`, extra, schemas);
      out.push([...kdoc(schema.description, ''), `typealias ${name} = ${type}`].join('\n'));
      for (const [n, s] of extra) renderClass(n, s, schemas, out);
    }
  }
  const ops = openapiOperations(doc).map((o) => {
    const [method, p] = o.key.split(' ');
    return { id: o.op.operationId, method, path: p, access: o.access, summary: o.op.summary };
  });
  for (const o of ops) if (!o.id) throw new Error(`${o.method} ${o.path} has no operationId`);
  const opLines = ['/** Every operation in openapi.yaml: method, path template and x-sa-access level. */', 'object ApiOperations {'];
  for (const o of ops) {
    opLines.push(...kdoc(o.summary, '    '));
    opLines.push(`    val ${ktProp(o.id)} = ApiOperation("${o.method}", "${o.path}", "${o.access}")`);
  }
  opLines.push('', `    val all: List<ApiOperation> = listOf(${ops.map((o) => ktProp(o.id)).join(', ')})`, '}');
  const header = [
    '// Generated by scripts/protocol.mjs from shared/protocol/openapi.yaml. Do not edit; run pnpm protocol.',
    '@file:Suppress("ktlint", "unused")',
    '',
    'package app.shareanywhere.data.api',
    '',
    'import kotlinx.serialization.SerialName',
    'import kotlinx.serialization.Serializable',
    ...['JsonElement', 'JsonObject'].filter((t) => out.some((c) => c.includes(`: ${t}`) || c.includes(`<${t}>`) || c.includes(`= ${t}`))).map((t) => `import kotlinx.serialization.json.${t}`),
    '',
    `/** openapi.yaml info.version this file was generated from. */`,
    `const val API_VERSION = "${doc.info?.version ?? ''}"`,
    '',
    '/** One API operation. `path` keeps its {placeholders}; `access` is the x-sa-access level (docs/API.md §1). */',
    'data class ApiOperation(val method: String, val path: String, val access: String) {',
    '    /** The path with each {name} replaced, in order, by the given values (URL-encoded by the caller). */',
    '    fun path(vararg values: String): String {',
    '        var i = 0',
    '        return Regex("\\\\{[^}]+\\\\}").replace(path) { m -> values.getOrElse(i++) { error("missing value for ${m.value}") } }',
    '    }',
    '}',
    '',
    '',
  ];
  return `${header.join('\n')}${opLines.join('\n')}\n\n${out.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// Swift models for the iOS client (docs/ADR/0023-ios-networking.md): one Codable struct per object schema,
// typealiases for primitive schemas, and APIOperations with every operation's method, path and access level.
// Enums stay String (allowed values in the doc comment) so a new server value never breaks decoding, as on Android.

const SWIFT_KEYWORDS = new Set(['associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout', 'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while', 'as', 'catch', 'false', 'is', 'nil', 'super', 'self', 'Self', 'throw', 'throws', 'true', 'try', 'Type', 'Protocol']);
/** Schema names that would shadow Swift standard library types. */
const SWIFT_RENAMES = { Error: 'ErrorResponse' };
const swName = (n) => SWIFT_RENAMES[n] ?? n;
const swProp = (name) => {
  const c = camel(name);
  return SWIFT_KEYWORDS.has(c) ? `\`${c}\`` : c;
};
const swDoc = (text, indent) => {
  if (!text) return [];
  return [`${indent}/// ${String(text).replace(/\s+/g, ' ').trim()}`];
};

function swType(schema, hint, extra, schemas) {
  if (!schema) return 'JSONValue';
  if (schema.$ref) return swName(refName(schema.$ref));
  if (schema.allOf && schema.allOf.length === 1) return swType(schema.allOf[0], hint, extra, schemas);
  if (schema.allOf || schema.oneOf || schema.anyOf) {
    if (schema.allOf) {
      extra.push([hint, schema]);
      return hint;
    }
    return 'JSONValue';
  }
  switch (schema.type) {
    case 'string':
      return 'String';
    case 'integer':
      return schema.format === 'int64' ? 'Int64' : 'Int';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Bool';
    case 'array':
      return `[${swType(schema.items, `${hint}Item`, extra, schemas)}]`;
    case 'object':
      if (schema.properties) {
        extra.push([hint, schema]);
        return hint;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return `[String: ${swType(schema.additionalProperties, `${hint}Value`, extra, schemas)}]`;
      }
      return '[String: JSONValue]';
    default:
      return 'JSONValue';
  }
}

function renderStruct(name, schema, schemas, out, description) {
  const extra = [];
  const { props, required } = objectShape(schema, schemas);
  const lines = [...swDoc(description ?? schema.description, '')];
  const entries = Object.entries(props);
  lines.push(`public struct ${name}: Codable, Sendable, Equatable {`);
  const fields = [];
  for (const [prop, ps] of entries) {
    const type = swType(ps, `${name}${pascalCase(prop)}`, extra, schemas);
    const optional = !required.has(prop) || ps.nullable === true;
    const doc = [ps.description, ps.enum ? `One of: ${ps.enum.join(', ')}.` : null, ps.format && !['int64'].includes(ps.format) ? `Format: ${ps.format}.` : null]
      .filter(Boolean)
      .join(' ');
    lines.push(...swDoc(doc, '    '));
    lines.push(`    public var ${swProp(prop)}: ${type}${optional ? '?' : ''}`);
    fields.push({ prop, name: swProp(prop), plain: camel(prop), type: `${type}${optional ? '?' : ''}`, optional });
  }
  if (fields.length) {
    lines.push('', `    public init(${fields.map((f) => `${f.plain}: ${f.type}${f.optional ? ' = nil' : ''}`).join(', ')}) {`);
    for (const f of fields) lines.push(`        self.${f.plain} = ${f.plain}`);
    lines.push('    }');
    lines.push('', '    enum CodingKeys: String, CodingKey {');
    for (const f of fields) lines.push(`        case ${f.name} = "${f.prop}"`);
    lines.push('    }');
  } else {
    lines.push('    public init() {}');
  }
  lines.push('}');
  out.push(lines.join('\n'));
  for (const [n, s] of extra) renderStruct(n, s, schemas, out);
}

export function renderSwiftModels(doc) {
  const schemas = doc.components?.schemas ?? {};
  const out = [];
  for (const [rawName, schema] of Object.entries(schemas)) {
    const name = swName(rawName);
    const isObject = schema.type === 'object' || schema.allOf || schema.properties;
    if (isObject) renderStruct(name, schema, schemas, out);
    else {
      const extra = [];
      const type = swType(schema, `${name}Value`, extra, schemas);
      out.push([...swDoc(schema.description, ''), `public typealias ${name} = ${type}`].join('\n'));
      for (const [n, s] of extra) renderStruct(n, s, schemas, out);
    }
  }
  const ops = openapiOperations(doc).map((o) => {
    const [method, p] = o.key.split(' ');
    return { id: o.op.operationId, method, path: p, access: o.access, summary: o.op.summary };
  });
  const opLines = ['/// Every operation in openapi.yaml: method, path template and x-sa-access level.', 'public enum APIOperations {'];
  for (const o of ops) {
    opLines.push(...swDoc(o.summary, '    '));
    opLines.push(`    public static let ${swProp(o.id)} = APIOperation(method: "${o.method}", path: "${o.path}", access: "${o.access}")`);
  }
  opLines.push('', `    public static let all: [APIOperation] = [${ops.map((o) => swProp(o.id)).join(', ')}]`, '}');
  const header = [
    '// Generated by scripts/protocol.mjs from shared/protocol/openapi.yaml. Do not edit; run pnpm protocol.',
    '// swiftlint:disable all',
    '// swiftformat:disable all',
    '',
    'import Foundation',
    '',
    '/// openapi.yaml info.version this file was generated from.',
    `public let apiVersion = "${doc.info?.version ?? ''}"`,
    '',
    '/// One API operation. `path` keeps its {placeholders}; `access` is the x-sa-access level (docs/API.md §1).',
    'public struct APIOperation: Sendable, Equatable {',
    '    public let method: String',
    '    public let path: String',
    '    public let access: String',
    '',
    '    /// The path with each {name} replaced, in order, by the given values (percent-encoded here).',
    '    public func path(_ values: String...) -> String {',
    '        var out = ""',
    '        var i = 0',
    '        var rest = Substring(path)',
    '        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {',
    '            out += rest[..<open]',
    '            precondition(i < values.count, "missing value for \\(rest[open...close])")',
    '            out += values[i].addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? values[i]',
    '            i += 1',
    '            rest = rest[rest.index(after: close)...]',
    '        }',
    '        return out + rest',
    '    }',
    '}',
    '',
    '/// Any JSON value, for schemas the generator does not model (free-form objects, oneOf).',
    'public enum JSONValue: Codable, Sendable, Equatable {',
    '    case null',
    '    case bool(Bool)',
    '    case number(Double)',
    '    case string(String)',
    '    case array([JSONValue])',
    '    case object([String: JSONValue])',
    '',
    '    public init(from decoder: any Decoder) throws {',
    '        let c = try decoder.singleValueContainer()',
    '        if c.decodeNil() { self = .null }',
    '        else if let b = try? c.decode(Bool.self) { self = .bool(b) }',
    '        else if let n = try? c.decode(Double.self) { self = .number(n) }',
    '        else if let s = try? c.decode(String.self) { self = .string(s) }',
    '        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }',
    '        else { self = .object(try c.decode([String: JSONValue].self)) }',
    '    }',
    '',
    '    public func encode(to encoder: any Encoder) throws {',
    '        var c = encoder.singleValueContainer()',
    '        switch self {',
    '        case .null: try c.encodeNil()',
    '        case let .bool(b): try c.encode(b)',
    '        case let .number(n): try c.encode(n)',
    '        case let .string(s): try c.encode(s)',
    '        case let .array(a): try c.encode(a)',
    '        case let .object(o): try c.encode(o)',
    '        }',
    '    }',
    '}',
    '',
    '',
  ];
  return `${header.join('\n')}${opLines.join('\n')}\n\n${out.join('\n\n')}\n`;
}

async function generateTypes() {
  const ast = await openapiTS(new URL(`file://${OPENAPI}`), { alphabetize: true });
  return `// Generated by scripts/protocol.mjs from shared/protocol/openapi.yaml. Do not edit.\n/* eslint-disable */\n${astToString(ast)}`;
}

function checkWsSchema(schema, md) {
  const problems = [];
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  try {
    ajv.compile(schema);
  } catch (e) {
    problems.push(`websocket-events.json is not a valid JSON Schema: ${e.message}`);
  }
  for (const [name, def] of Object.entries(schema.$defs ?? {})) {
    if (def['x-sa-direction'] === 'shared') continue; // building blocks such as Participant, not messages
    const type = def.properties?.type?.const;
    if (!type) problems.push(`websocket-events.json $defs.${name} has no type const`);
    else if (!md.includes(`\`${type}\``)) problems.push(`WebSocket event ${type} is not listed in docs/API.md §4`);
    if (!Number.isInteger(def['x-sa-phase'])) problems.push(`websocket-events.json $defs.${name} has no x-sa-phase`);
  }
  return problems;
}

async function main() {
  const check = process.argv.includes('--check');
  const generated = await generateTypes();
  const kotlin = renderKotlinModels(YAML.parse(readFileSync(OPENAPI, 'utf8')));
  const swift = renderSwiftModels(YAML.parse(readFileSync(OPENAPI, 'utf8')));
  if (!check) {
    writeFileSync(TS_OUT, generated);
    console.log(`wrote ${path.relative(root, TS_OUT)}`);
    mkdirSync(path.dirname(KT_OUT), { recursive: true });
    writeFileSync(KT_OUT, kotlin);
    console.log(`wrote ${path.relative(root, KT_OUT)}`);
    mkdirSync(path.dirname(SWIFT_OUT), { recursive: true });
    writeFileSync(SWIFT_OUT, swift);
    console.log(`wrote ${path.relative(root, SWIFT_OUT)}`);
    return;
  }
  const problems = [];
  const raw = YAML.parse(readFileSync(OPENAPI, 'utf8'));
  try {
    await SwaggerParser.validate(structuredClone(raw));
  } catch (e) {
    problems.push(`openapi.yaml is invalid: ${e.message}`);
  }
  const md = readFileSync(API_MD, 'utf8');
  const sections = raw.info?.['x-sa-api-sections'] ?? [];
  if (!sections.length) problems.push('openapi.yaml info.x-sa-api-sections must list the docs/API.md sections it implements');
  problems.push(...compare(openapiOperations(raw), apiMdEndpoints(md), sections));
  problems.push(...checkWsSchema(JSON.parse(readFileSync(WS_SCHEMA, 'utf8')), md));
  let current = '';
  try {
    current = readFileSync(TS_OUT, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== generated) problems.push(`${path.relative(root, TS_OUT)} is stale; run pnpm protocol`);
  let currentKt = '';
  try {
    currentKt = readFileSync(KT_OUT, 'utf8');
  } catch {
    /* missing */
  }
  if (currentKt !== kotlin) problems.push(`${path.relative(root, KT_OUT)} is stale; run pnpm protocol`);
  let currentSwift = '';
  try {
    currentSwift = readFileSync(SWIFT_OUT, 'utf8');
  } catch {
    /* missing */
  }
  if (currentSwift !== swift) problems.push(`${path.relative(root, SWIFT_OUT)} is stale; run pnpm protocol`);
  if (problems.length) {
    console.error(`protocol: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`protocol: ${openapiOperations(raw).length} operations valid and in agreement with docs/API.md; generated TypeScript, Kotlin and Swift clients current.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
