// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cssVariables, colorTokens, palettes } from './tokens';

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

describe('generated design tokens', () => {
  it('declares a CSS custom property for every token', () => {
    const missing = cssVariables.filter((name) => !css.includes(`${name}:`));
    expect(missing).toEqual([]);
  });

  it('defines every color for the dark theme in both dark selectors', () => {
    const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
    const mediaBlock = css.slice(
      css.indexOf('@media (prefers-color-scheme: dark)'),
      css.indexOf(':root[data-theme="dark"]'),
    );
    for (const name of colorTokens) {
      expect(darkBlock).toContain(`--sa-color-${name}: ${palettes.dark[name]};`);
      expect(mediaBlock).toContain(`--sa-color-${name}: ${palettes.dark[name]};`);
    }
  });

  it('defines every color for the light theme on :root', () => {
    const lightBlock = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
    for (const name of colorTokens) expect(lightBlock).toContain(`--sa-color-${name}: ${palettes.light[name]};`);
  });
});
