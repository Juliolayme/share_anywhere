import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractObjectLiteral, slugify, validateCatalogs, buildCatalogs, flatten } from './gen-i18n.mjs';

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
