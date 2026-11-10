import { useState } from 'react';
import { colorTokens, fontSizes, palettes, radius, space } from '../styles/tokens';
import { getThemePreference, setThemePreference, type ThemePreference } from '../lib/theme';

// Development-only page that renders every design token in the live theme and both palettes side by side.
// Brand marks are added here once the Claude Design handoff (design/claude-design/Logo.dc.html) is imported.
export default function BrandPreview() {
  const [pref, setPref] = useState<ThemePreference>(getThemePreference());
  const choose = (p: ThemePreference) => {
    setPref(p);
    setThemePreference(p);
  };

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">Brand and token preview</h1>
        <fieldset className="flex gap-2 rounded-lg border border-border bg-surface p-1">
          <legend className="sr-only">Theme</legend>
          {(['system', 'light', 'dark'] as const).map((p) => (
            <label
              key={p}
              className={`min-h-touch cursor-pointer rounded-md px-3 py-2 text-sm focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-focus ${pref === p ? 'bg-primary text-on-primary' : 'text-text'}`}
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

      <section aria-labelledby="live-colors">
        <h2 id="live-colors" className="mb-3 text-xl font-semibold">
          Colors in the current theme
        </h2>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {colorTokens.map((name) => (
            <li key={name} data-testid={`swatch-${name}`} className="rounded-md border border-border bg-surface p-2">
              <div className="h-10 rounded-sm border border-border" style={{ background: `var(--sa-color-${name})` }} />
              <p className="mt-2 font-mono text-xs">{name}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="both-themes">
        <h2 id="both-themes" className="mb-3 text-xl font-semibold">
          Light and dark side by side
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {(['light', 'dark'] as const).map((theme) => {
            const p = palettes[theme];
            return (
              <div
                key={theme}
                data-testid={`panel-${theme}`}
                className="flex flex-col gap-3 rounded-lg p-4"
                style={{ background: p.bg, color: p.text, border: `1px solid ${p.border}` }}
              >
                <p className="text-lg font-semibold">{theme === 'light' ? 'Light' : 'Dark'}</p>
                <p style={{ color: p['text-muted'] }}>Muted supporting text</p>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-md px-3 py-2" style={{ background: p.primary, color: p['on-primary'] }}>
                    Send files
                  </span>
                  <span
                    className="rounded-md px-3 py-2"
                    style={{ background: p['receive-soft'], color: p['on-receive-soft'] }}
                  >
                    Receive files
                  </span>
                  <span className="rounded-md px-3 py-2" style={{ background: p['error-soft'], color: p.error }}>
                    Error
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="type-scale">
        <h2 id="type-scale" className="mb-3 text-xl font-semibold">
          Type scale
        </h2>
        <ul className="flex flex-col gap-2">
          {Object.keys(fontSizes).map((k) => (
            <li key={k} style={{ fontSize: `var(--sa-text-${k})`, lineHeight: `var(--sa-leading-${k})` }}>
              <span className="font-mono text-xs text-text-muted">{k}</span> Chia sẻ tệp ở mọi nơi · Share files
              anywhere
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="space-radius">
        <h2 id="space-radius" className="mb-3 text-xl font-semibold">
          Spacing and radius
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          {Object.keys(space).map((k) => (
            <div key={k} className="flex flex-col items-center gap-1">
              <div className="bg-primary" style={{ width: `var(--sa-space-${k})`, height: `var(--sa-space-${k})` }} />
              <span className="font-mono text-xs">{k}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          {Object.keys(radius).map((k) => (
            <div
              key={k}
              className="flex h-12 w-16 items-center justify-center border border-border-strong bg-surface-muted font-mono text-xs"
              style={{ borderRadius: `var(--sa-radius-${k})` }}
            >
              {k}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
