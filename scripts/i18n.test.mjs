import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractObjectLiteral, extractLocaleTables, slugify, validateCatalogs, buildCatalogs, flatten } from './gen-i18n.mjs';
import { readFileSync } from 'node:fs';

test('extracts an object literal even when strings contain braces and quotes', () => {
  const src = "const X = 1; const T = { en: { a: 'has } brace', b: \"it's {n}\" }, vi: { a: 'có } dấu', b: 'của {n}' } }; const Y = {};";
  assert.equal(extractObjectLiteral(src, 'T').slice(-3), '} }');
  assert.ok(extractObjectLiteral(src, 'T').includes("'có } dấu'"));
});

test('slugify removes Vietnamese diacritics and punctuation', () => {
  assert.equal(slugify('Code expired — Create new code'), 'code_expired_create_new_code');
  assert.equal(slugify('Đã chép!'), 'da_chep');
  assert.equal(slugify('—'), 'phrase');
});

test('validation reports missing keys, empty strings, and placeholder mismatches', () => {
  const problems = validateCatalogs({
    en: { a: 'Hello', b: 'Sending to {n}', c: '' },
    vi: { a: 'Xin chào', b: 'Đang gửi tới', d: 'x' },
  });
  assert.ok(problems.includes('missing in vi: c'));
  assert.ok(problems.includes('missing in en: d'));
  assert.ok(problems.includes('placeholder mismatch: b'));
  assert.ok(problems.includes('empty en string: c'));
});

test('catalogs built from the design handoff are valid and carry the key product strings', () => {
  const catalogs = buildCatalogs();
  assert.deepEqual(validateCatalogs(catalogs), []);
  const en = flatten(catalogs.en);
  const vi = flatten(catalogs.vi);
  assert.equal(en['web.send'], 'Send files');
  assert.equal(vi['web.send'], 'Gửi tệp');
  assert.equal(en['common.cx_h'], 'Code expired — Create new code');
  assert.equal(vi['common.cx_h'], 'Mã đã hết hạn — Tạo mã mới');
  assert.equal(en['common.s_wake'], 'Keep screen on during transfers');
});

test('every {en, vi} table in each prototype is extracted, and an unparseable one fails', () => {
  const src = "const T = { en: { a: 'A' }, vi: { a: 'Á' } }; const XX = {\"en\":{\"b\":\"B\"},\"vi\":{\"b\":\"Bé\"}}; const CHIP = { x: 1 };";
  assert.deepEqual(Object.keys(extractLocaleTables(src)).sort(), ['T', 'XX']);
  assert.throws(() => extractLocaleTables("const BAD = { en: { a: 'A' , }, vi: { a: oops } };"), /could not be parsed/);
});

test('catalogs include every locale table, the handoff microcopy, and the product overlay', () => {
  const en = flatten(buildCatalogs().en);
  for (const file of ['Web App.dc.html', 'Android App.dc.html', 'iOS App.dc.html']) {
    const src = readFileSync(new URL(`../design/claude-design/${file}`, import.meta.url), 'utf8');
    const names = Object.keys(extractLocaleTables(src));
    assert.ok(names.length >= 2, `${file} should have several string tables`);
  }
  const values = Object.values(en);
  for (const required of ['Start sharing', 'Screen stays on', 'Code expired — Create new code', 'Session full — extra devices are declined automatically.']) {
    assert.ok(values.includes(required), `missing "${required}"`);
  }
  assert.equal(en['product.block'], 'Block');
  assert.equal(en['product.join_within'], 'Join within {time}');
});

test('every catalog key named in the PRD section 9 microcopy table exists in EN and VI', () => {
  const prd = readFileSync(new URL('../docs/PRODUCT_REQUIREMENTS.md', import.meta.url), 'utf8');
  const section = prd.slice(prd.indexOf('Microcopy lives in the catalogs'), prd.indexOf('## 10.'));
  const keys = [...section.matchAll(/`([a-z_]+\.[a-z0-9_]+)`/g)].map((m) => m[1]).filter((k) => !k.endsWith('.json') && !k.endsWith('.mjs'));
  assert.ok(keys.length >= 30, `expected the microcopy table, found ${keys.length} keys`);
  const { en, vi } = buildCatalogs();
  const fe = flatten(en);
  const fv = flatten(vi);
  const missing = keys.filter((k) => !(k in fe) || !(k in fv));
  assert.deepEqual(missing, []);
});

test('TRP patterns convert to templates without executing code', async () => {
  const { patternToTemplates } = await import('./gen-i18n.mjs');
  assert.deepEqual(patternToTemplates('^(.+) joined$', "m[1] + ' đã vào phiên'"), { en: '{1} joined', vi: '{1} đã vào phiên' });
  assert.deepEqual(patternToTemplates('^(\\d+) devices? (was|were) declined$', "m[1] + ' thiết bị'"), { en: '{1} devices were declined', vi: '{1} thiết bị' });
  assert.throws(() => patternToTemplates('^(.+) joined$', 'm[1].toUpperCase()'), /Unsupported VI expression/);
});
