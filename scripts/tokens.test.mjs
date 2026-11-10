import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio } from './lib/contrast.mjs';
import { loadTokens, validateTokens, checkContrast } from './lib/tokens.mjs';
import { renderCss, cssVariableNames } from './gen-tokens.mjs';

test('contrast ratio matches WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#FFFFFF').toFixed(2), '21.00');
  assert.equal(contrastRatio('#FFFFFF', '#FFFFFF').toFixed(2), '1.00');
  assert.equal(contrastRatio('#767676', '#FFFFFF').toFixed(2), '4.54');
});

test('tokens.json matches its schema', () => {
  assert.deepEqual(validateTokens(loadTokens()), []);
});

test('every declared text pair meets WCAG AA and non-text pairs meet 3:1 in both themes', () => {
  assert.deepEqual(checkContrast(loadTokens()), []);
});

test('light and dark palettes define the same tokens', () => {
  const t = loadTokens();
  assert.deepEqual(Object.keys(t.color.light).sort(), Object.keys(t.color.dark).sort());
  assert.deepEqual(Object.keys(t.elevation.light).sort(), Object.keys(t.elevation.dark).sort());
});

test('generated CSS declares every variable and the dark theme in both selectors', () => {
  const t = loadTokens();
  const css = renderCss(t);
  for (const name of cssVariableNames(t)) assert.ok(css.includes(`${name}:`), `missing ${name}`);
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'));
  assert.ok(css.includes(':root:not([data-theme="light"])'));
  assert.ok(css.includes(':root[data-theme="dark"]'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
});

test('a failing pair is reported', () => {
  const t = structuredClone(loadTokens());
  t.color.light['text-muted'] = '#C0C0C0';
  const failures = checkContrast(t);
  assert.ok(failures.some((f) => f.startsWith('light: text-muted on')));
});
