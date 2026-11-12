import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractObjectLiteral, extractLocaleTables, slugify, validateCatalogs, buildCatalogs, flatten, extractInlinePairs } from './gen-i18n.mjs';
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
  // Positional design keys could be renumbered by a re-import; pin their meaning.
  assert.equal(fe['web_vv.k34'], 'Start sharing');
  assert.equal(fe['web_xx.wake_on'], 'Screen stays on');
  assert.equal(fe['common.local'], 'Stored only on this device');
  assert.equal(fe['common.cx_rx'], 'Code expired — ask the sender for a new code');
});

test('inline L(en, vi) pairs from the native prototypes are extracted', () => {
  const en = flatten(buildCatalogs().en);
  for (const app of ['android', 'ios']) {
    assert.equal(en[`${app}_log.joined_the_session`], 'Joined the session');
    assert.equal(en[`${app}_log.direct_path_blocked_symmetric_nat`], 'Direct path blocked (symmetric NAT)');
  }
});

test('TRP patterns convert to templates without executing code', async () => {
  const { patternToTemplates } = await import('./gen-i18n.mjs');
  assert.deepEqual(patternToTemplates('^(.+) joined$', "m[1] + ' đã vào phiên'"), { en: '{1} joined', vi: '{1} đã vào phiên' });
  assert.deepEqual(patternToTemplates('^(\\d+) devices? (was|were) declined$', "m[1] + ' thiết bị'"), { en: '{1} devices were declined', vi: '{1} thiết bị' });
  assert.throws(() => patternToTemplates('^(.+) joined$', 'm[1].toUpperCase()'), /Unsupported VI expression/);
});

test('inline L() extraction fails loudly on an unsupported form or a key collision', () => {
  assert.deepEqual(extractInlinePairs("L('a b', 'c')").en, { a_b: 'a b' });
  assert.throws(() => extractInlinePairs('L("dq", "vi") L(\'a b\', \'c\')'), /2 L\( calls but extracted 1/);
  assert.throws(() => extractInlinePairs("L('A b', 'x') L('a-b', 'y')"), /collide/);
});

test('Android string resources escape aapt2 specials and keep placeholders', async () => {
  const { escapeAndroidString, androidResourceName, androidStrings, renderAndroidStrings, isAndroidNamespace } = await import('./gen-i18n.mjs');
  assert.equal(escapeAndroidString("Don't <b> & \"q\""), "Don\\'t &lt;b&gt; &amp; \\\"q\\\"");
  assert.equal(escapeAndroidString('@home'), '\\@home');
  assert.equal(escapeAndroidString('?x'), '\\?x');
  assert.equal(escapeAndroidString(' characters'), '\\u0020characters');
  assert.equal(escapeAndroidString('a  b\nc\\d'), 'a \\u0020b\\nc\\\\d');
  assert.equal(escapeAndroidString('Join within {time}'), 'Join within {time}');
  assert.equal(androidResourceName('android_yy.cb_clear'), 'android_yy_cb_clear');
  assert.throws(() => androidResourceName('1x.y'), /start with a letter/);
  assert.throws(() => androidStrings({ android: { 'a-b': 'x', a_b: 'y' } }), /collide/);
  assert.ok(isAndroidNamespace('android_vv') && isAndroidNamespace('product') && !isAndroidNamespace('web') && !isAndroidNamespace('ios_xx'));
  const xml = renderAndroidStrings({ android: { pct: '15%' }, web: { send: 'Send files' } });
  assert.ok(xml.includes('<string name="android_pct" formatted="false">15%</string>'));
  assert.ok(!xml.includes('web_send'));
});

test('the Android slice holds the guest shell strings in both languages', async () => {
  const { androidStrings } = await import('./gen-i18n.mjs');
  const catalogs = buildCatalogs();
  const en = androidStrings(catalogs.en);
  const vi = androidStrings(catalogs.vi);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort());
  assert.equal(en.android_vv_k34, 'Start sharing');
  assert.equal(vi.android_send, 'Gửi tệp');
  assert.equal(en.android_yy_s_wake, 'Keep screen on during transfers');
  assert.ok(en.product_welcome_android_p.startsWith('Send 4–20 GB'));
});

test('the iOS String Catalog carries the iOS slice in EN and VI with placeholders as text', async () => {
  const { buildCatalogs, renderXcstrings, isIosNamespace } = await import('./gen-i18n.mjs');
  const catalogs = buildCatalogs();
  const doc = JSON.parse(renderXcstrings(catalogs));
  assert.equal(doc.sourceLanguage, 'en');
  const keys = Object.keys(doc.strings);
  assert.ok(keys.length > 500);
  assert.ok(keys.every((k) => isIosNamespace(k.split('.')[0])), 'only the iOS slice');
  assert.ok(!keys.some((k) => k.startsWith('android')), 'no Android strings');
  const sample = doc.strings[keys.find((k) => k.startsWith('ios.'))];
  assert.equal(sample.extractionState, 'manual');
  assert.ok(sample.localizations.en.stringUnit.value && sample.localizations.vi.stringUnit.value);
});
