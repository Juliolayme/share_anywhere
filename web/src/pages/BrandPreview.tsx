import { useState } from 'react';
import { Logo } from '../components/Logo';
import { colorTokens, typeScale, palettes, radius, space, elevationLevels, control } from '../styles/tokens';
import { getThemePreference, setThemePreference, type ThemePreference } from '../lib/theme';

// Development-only page (excluded from production builds) that renders the brand and every design token
// as specified in design/claude-design/Brand.dc.html and Design System.dc.html.
const LOCKUPS = [
  { label: 'Primary · on light', mode: 'color', bg: '#FFFFFF', dot: undefined },
  { label: 'Reverse · on navy', mode: 'dark', bg: '#102A56', dot: undefined },
  { label: 'Mono · navy', mode: 'mono-dark', bg: '#F7FAFD', dot: '#F7FAFD' },
  { label: 'Mono · white', mode: 'mono-light', bg: '#0B1A33', dot: '#0B1A33' },
] as const;

const TYPE_SAMPLES: Record<string, string> = {
  display: 'Send files',
  headline: 'Receiving files',
  title: 'Active transfers',
  'label-lg': 'Project_Final_4K.mov',
  body: 'Your clipboard content is encrypted before sync.',
  caption: 'Last online 2 min ago',
  code: '482 913',
};

// Tailwind only generates classes it can see as complete strings, so map tokens to literal class names.
const TYPE_CLASS: Record<string, string> = {
  display: 'text-display',
  headline: 'text-headline',
  title: 'text-title',
  'label-lg': 'text-label-lg',
  body: 'text-body',
  caption: 'text-caption',
  code: 'text-code',
};
const CONTROL_CLASS: Record<string, string> = { sm: 'h-control-sm', md: 'h-control-md', lg: 'h-control-lg' };

export default function BrandPreview() {
  const [pref, setPref] = useState<ThemePreference>(getThemePreference());
  const choose = (p: ThemePreference) => {
    setPref(p);
    setThemePreference(p);
  };

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-8 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Logo size={40} lockup />
          <h1 className="text-headline">Brand and token preview</h1>
        </div>
        <fieldset className="flex gap-2 rounded-lg border border-border bg-surface p-1">
          <legend className="sr-only">Theme</legend>
          {(['system', 'light', 'dark'] as const).map((p) => (
            <label
              key={p}
              className={`min-h-touch cursor-pointer rounded-md px-3 py-2 text-caption focus-within:outline focus-within:outline-focus focus-within:outline-offset-focus focus-within:outline-focus ${pref === p ? 'bg-send text-on-send' : 'text-fg'}`}
            >
              <input
                type="radio"
                name="theme"
                value={p}
                checked={pref === p}
                onChange={() => choose(p)}
                className="sr-only"
              />
              {p[0]?.toUpperCase() + p.slice(1)}
            </label>
          ))}
        </fieldset>
      </header>

      <section aria-labelledby="lockups">
        <h2 id="lockups" className="mb-3 text-title">
          Logo lockups
        </h2>
        <ul className="grid grid-cols-1 gap-4 rail:grid-cols-2">
          {LOCKUPS.map((l) => (
            <li
              key={l.label}
              data-testid={`lockup-${l.mode}`}
              className="flex h-[160px] flex-col items-center justify-center gap-4 rounded-xl border border-border"
              style={{ background: l.bg }}
            >
              <Logo size={48} mode={l.mode} lockup dotColor={l.dot} />
              <span
                className="font-mono text-caption"
                style={{ color: l.mode === 'color' || l.mode === 'mono-dark' ? '#4A5B78' : '#A9B8CF' }}
              >
                {l.label}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-end gap-6">
          {[88, 48, 32, 24, 16, 12].map((s) => (
            <div key={s} className="flex flex-col items-center gap-2">
              <Logo size={s} label={`Symbol ${s} px`} />
              <span className="font-mono text-caption text-fg-2">{s}</span>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="live-colors">
        <h2 id="live-colors" className="mb-3 text-title">
          Colors in the current theme
        </h2>
        <ul className="grid grid-cols-2 gap-3 rail:grid-cols-4">
          {colorTokens.map((name) => (
            <li key={name} data-testid={`swatch-${name}`} className="rounded-md border border-border bg-surface p-2">
              <div className="h-[40px] rounded-sm border border-border" style={{ background: `var(--sa-${name})` }} />
              <p className="mt-2 font-mono text-caption">{name}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="both-themes">
        <h2 id="both-themes" className="mb-3 text-title">
          Light and dark side by side
        </h2>
        <div className="grid gap-4 rail:grid-cols-2">
          {(['light', 'dark'] as const).map((theme) => {
            const p = palettes[theme];
            return (
              <div
                key={theme}
                data-testid={`panel-${theme}`}
                className="flex flex-col gap-3 rounded-lg p-4"
                style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}
              >
                <p className="text-label-lg">{theme === 'light' ? 'Light' : 'Dark'}</p>
                <p style={{ color: p['fg-2'] }}>Secondary text on the canvas</p>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-md px-4 py-2" style={{ background: p.send, color: p['on-send'] }}>
                    Send files
                  </span>
                  <span
                    className="rounded-md px-4 py-2"
                    style={{ background: p['receive-soft'], color: p['receive-ink'] }}
                  >
                    Receive files
                  </span>
                  <span
                    className="rounded-md px-4 py-2"
                    style={{ background: p['danger-soft'], color: p['danger-ink'] }}
                  >
                    Failed
                  </span>
                  <span className="rounded-md px-4 py-2" style={{ background: p['cloud-soft'], color: p['cloud-ink'] }}>
                    Cloud
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="type-scale">
        <h2 id="type-scale" className="mb-3 text-title">
          Type scale
        </h2>
        <ul className="flex flex-col gap-2">
          {Object.entries(typeScale).map(([k, ty]) => (
            <li key={k} data-testid={`type-${k}`} className="flex items-baseline gap-4">
              <span className="w-[96px] shrink-0 font-mono text-caption text-fg-2">{k}</span>
              <span className={`${TYPE_CLASS[k] ?? 'text-body'} ${ty.family === 'mono' ? 'font-mono' : 'font-sans'}`}>
                {TYPE_SAMPLES[k]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="space-radius">
        <h2 id="space-radius" className="mb-3 text-title">
          Spacing, radius, elevation, control heights
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          {Object.keys(space).map((k) => (
            <div key={k} className="flex flex-col items-center gap-1">
              <div className="bg-send" style={{ width: `var(--sa-space-${k})`, height: `var(--sa-space-${k})` }} />
              <span className="font-mono text-caption">{k}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          {Object.keys(radius).map((k) => (
            <div
              key={k}
              className="flex h-[48px] w-[64px] items-center justify-center border border-border-strong bg-surface-2 font-mono text-caption"
              style={{ borderRadius: `var(--sa-radius-${k})` }}
            >
              {k}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-4">
          {elevationLevels.map((k) => (
            <div
              key={k}
              className={`flex h-[56px] w-[90px] items-center justify-center rounded-md bg-surface font-mono text-caption ${k === 'e0' ? 'border border-border' : ''}`}
              style={{ boxShadow: `var(--sa-elevation-${k})` }}
            >
              {k}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          {Object.keys(control).map((k) => (
            <span
              key={k}
              className={`inline-flex ${CONTROL_CLASS[k] ?? 'h-control-md'} items-center rounded-md bg-send px-4 text-on-send`}
            >
              {k}
            </span>
          ))}
        </div>
      </section>
    </main>
  );
}
