import type { Config } from 'tailwindcss';
import { colorTokens, typeScale, space, radius, control, breakpoints, elevationLevels } from './src/styles/tokens';

// Token names map 1:1 to Tailwind theme keys (design/claude-design/Design System.dc.html, "Handoff — token naming").
// Every value is a CSS custom property generated from shared/design/tokens.json, so themes switch without rebuilding.
const colors = Object.fromEntries(colorTokens.map((name) => [name, `var(--sa-${name})`]));

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    screens: breakpoints,
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      brand: {
        blue: 'var(--sa-brand-blue)',
        green: 'var(--sa-brand-green)',
        navy: 'var(--sa-brand-navy)',
        white: 'var(--sa-brand-white)',
      },
      ...colors,
    },
    spacing: { 0: '0px', ...Object.fromEntries(Object.keys(space).map((k) => [k, `var(--sa-space-${k})`])) },
    borderRadius: Object.fromEntries(Object.keys(radius).map((k) => [k, `var(--sa-radius-${k})`])),
    boxShadow: Object.fromEntries(elevationLevels.map((k) => [k, `var(--sa-elevation-${k})`])),
    fontFamily: { sans: 'var(--sa-font-sans)', mono: 'var(--sa-font-mono)' },
    fontSize: Object.fromEntries(
      Object.keys(typeScale).map((k) => [
        k,
        [
          `var(--sa-type-${k}-size)`,
          { lineHeight: `var(--sa-type-${k}-line)`, fontWeight: `var(--sa-type-${k}-weight)` },
        ],
      ]),
    ),
    extend: {
      height: Object.fromEntries(Object.keys(control).map((k) => [`control-${k}`, `var(--sa-control-${k})`])),
      minHeight: { touch: 'var(--sa-touch-target)' },
      minWidth: { touch: 'var(--sa-touch-target)' },
      outlineWidth: { focus: 'var(--sa-border-focus)' },
      outlineOffset: { focus: 'var(--sa-border-focusOffset)' },
      transitionDuration: { fast: 'var(--sa-duration-fast)', base: 'var(--sa-duration-base)' },
    },
  },
  plugins: [],
} satisfies Config;
