import { encode } from 'uqr';
import { useMemo } from 'react';

/** QR code as crisp SVG (dark modules on a white quiet zone so phone cameras read it in both themes). */
export function QRCode({ value, size = 176, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = encode(value, { ecc: 'Q', border: 0 });
    let d = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, n: qr.size };
  }, [value]);
  return (
    <span className="inline-flex rounded-lg border border-border bg-[#fff] p-3">
      <svg
        width={size}
        height={size}
        viewBox={`-2 -2 ${n + 4} ${n + 4}`}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#FFFFFF" />
        <path d={path} fill="#102A56" />
        {/* Center mark from the design: send and receive bars on a white tile (inside the error-correction budget). */}
        <rect x={n / 2 - 3} y={n / 2 - 3} width={6} height={6} rx={1.4} fill="#FFFFFF" />
        <rect x={n / 2 - 2.2} y={n / 2 - 1.9} width={3.6} height={1.6} rx={0.8} fill="#0878E8" />
        <rect x={n / 2 - 1.4} y={n / 2 + 0.3} width={3.6} height={1.6} rx={0.8} fill="#16C75A" />
      </svg>
    </span>
  );
}
