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
  t.color.light['fg-2'] = '#C0C0C0';
  const failures = checkContrast(t);
  assert.ok(failures.some((f) => f.startsWith('light: fg-2 on')));
});

test('a logo theme mode with an unreadable wordmark is reported', () => {
  const t = structuredClone(loadTokens());
  t.logo.themeMode.dark = 'color';
  assert.ok(checkContrast(t).some((f) => f.startsWith('dark: logo wordmark on bg')));
});

test('Kotlin tokens carry every colour in both themes, ARGB with alpha for rgba values', async () => {
  const { renderKotlin, kotlinColor, kotlinName, shadowElevation } = await import('./gen-tokens.mjs');
  const t = loadTokens();
  const kt = renderKotlin(t);
  for (const theme of ['light', 'dark']) {
    for (const [name, value] of Object.entries(t.color[theme])) {
      assert.ok(kt.includes(`${kotlinName(name)} = ${kotlinColor(value)},`), `${theme}.${name}`);
      assert.ok(kt.includes(`"${name}" to ${kotlinName(name)},`), `byToken ${name}`);
    }
  }
  assert.equal(kotlinColor('#0a6fd6'), 'Color(0xFF0A6FD6)');
  assert.equal(kotlinColor('rgba(16, 42, 86, 0.32)'), 'Color(0x52102A56)');
  assert.throws(() => kotlinColor('hsl(0 0% 0%)'), /Unsupported color/);
  assert.equal(kotlinName('border-strong'), 'borderStrong');
  assert.equal(shadowElevation('none'), 0);
  assert.equal(shadowElevation('0 8px 24px rgba(16, 42, 86, 0.12)'), 8);
  assert.ok(kt.includes('val TouchTarget: Dp = 48.dp'));
  assert.ok(kt.includes('val S4: Dp = 16.dp'));
});
