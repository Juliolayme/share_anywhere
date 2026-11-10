import { logo, type LogoMode } from '../styles/tokens';

interface LogoProps {
  /** Symbol height in px. Below 16 px the design drops the dots; below 24 px use the symbol alone. */
  size?: number;
  mode?: LogoMode;
  /** Show the "Share Anywhere" wordmark next to the symbol. */
  lockup?: boolean;
  /** Override the dot color, e.g. to match the background in mono modes (Brand.dc.html). */
  dotColor?: string | undefined;
  /** Accessible name; pass an empty string when the logo is decorative next to visible text. */
  label?: string;
}

// Mirrors design/claude-design/Logo.dc.html: two passing capsules (blue sends, green receives) with lead dots.
export function Logo({ size = 40, mode = 'color', lockup = false, dotColor, label = 'Share Anywhere' }: LogoProps) {
  const m = logo.modes[mode];
  const g = logo.geometry;
  const showDots = size >= logo.dotlessBelowPx;
  const [sx, sy, sw, sh, sr] = g.capsuleSend;
  const [rx, ry, rw, rh, rr] = g.capsuleReceive;
  const decorative = label === '' || lockup;
  const symbol = (
    <svg
      width={size}
      height={size}
      viewBox={g.viewBox}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      <rect x={sx} y={sy} width={sw} height={sh} rx={sr} fill={m.send} />
      <rect x={rx} y={ry} width={rw} height={rh} rx={rr} fill={m.receive} />
      {showDots && (
        <>
          <circle cx={g.dotSend[0]} cy={g.dotSend[1]} r={g.dotSend[2]} fill={dotColor ?? m.dot} />
          <circle cx={g.dotReceive[0]} cy={g.dotReceive[1]} r={g.dotReceive[2]} fill={dotColor ?? m.dot} />
        </>
      )}
    </svg>
  );
  if (!lockup) return symbol;
  return (
    <span
      className="inline-flex items-center whitespace-nowrap leading-none"
      style={{ gap: Math.round(size * logo.wordmark.gapRatio) }}
      role={label === '' ? undefined : 'img'}
      aria-label={label === '' ? undefined : label}
    >
      {symbol}
      <span
        aria-hidden="true"
        style={{
          fontWeight: logo.wordmark.fontWeight,
          fontSize: Math.round(size * logo.wordmark.sizeRatio),
          letterSpacing: logo.wordmark.letterSpacing,
          color: m.text,
        }}
      >
        Share Anywhere
      </span>
    </span>
  );
}
