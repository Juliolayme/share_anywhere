import { encode } from 'uqr';
import { useMemo } from 'react';

/** QR code as crisp SVG (dark modules on a white quiet zone so phone cameras read it in both themes). */
export function QRCode({ value, size = 176, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 0 });
    let d = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, n: qr.size };
  }, [value]);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-2 -2 ${n + 4} ${n + 4}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="rounded-md bg-[#fff]"
    >
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#FFFFFF" />
      <path d={path} fill="#102A56" />
    </svg>
  );
}
