import type { Config } from 'tailwindcss';
import { colorTokens, fontSizes, space, radius, breakpoints, elevationLevels } from './src/styles/tokens';

// Every value maps to a CSS custom property generated from shared/design/tokens.json,
// so light and dark themes switch without rebuilding and no one-off values are needed.
const colors = Object.fromEntries(colorTokens.map((name) => [name, `var(--sa-color-${name})`]));

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
    spacing: Object.fromEntries(Object.keys(space).map((k) => [k, `var(--sa-space-${k})`])),
    borderRadius: Object.fromEntries(Object.keys(radius).map((k) => [k, `var(--sa-radius-${k})`])),
    boxShadow: Object.fromEntries(elevationLevels.map((k) => [k, `var(--sa-elevation-${k})`])),
    fontFamily: { sans: 'var(--sa-font-sans)', mono: 'var(--sa-font-mono)' },
    fontSize: Object.fromEntries(
      Object.keys(fontSizes).map((k) => [k, [`var(--sa-text-${k})`, { lineHeight: `var(--sa-leading-${k})` }]]),
    ),
    extend: {
      minHeight: { touch: 'var(--sa-touch-target)' },
      minWidth: { touch: 'var(--sa-touch-target)' },
      transitionDuration: { fast: 'var(--sa-duration-fast)', base: 'var(--sa-duration-base)' },
    },
  },
  plugins: [],
} satisfies Config;
