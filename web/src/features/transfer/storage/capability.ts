// Browser capability check shown before a receive starts (PRD §6.8, docs/UX_SCREEN_MAP.md RX-5b).
import { MEMORY_LIMIT } from './memory';
import type { SaveMode } from './progress-store';

export type Family = 'chromium' | 'firefox' | 'safari' | 'other';

export interface Capabilities {
  family: Family;
  mobile: boolean;
  ios: boolean;
  folder: boolean;
  opfs: boolean;
  /** Free browser storage in bytes (quota − usage), or null when the browser does not say. */
  freeBytes: number | null;
}

export function browserFamily(ua: string): { family: Family; mobile: boolean; ios: boolean } {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  const mobile = ios || /Android|Mobile/.test(ua);
  if (/Firefox\/|FxiOS/.test(ua)) return { family: 'firefox', mobile, ios };
  if (/Chrome\/|Chromium\/|CriOS|Edg\//.test(ua) && !/CriOS/.test(ua)) return { family: 'chromium', mobile, ios };
  if (/Safari\//.test(ua) || ios) return { family: 'safari', mobile, ios };
  return { family: 'other', mobile, ios };
}

export interface ModeOption {
  mode: SaveMode;
  available: boolean;
  /** Why the option cannot be used, as a catalog key. */
  reason?: 'unsupported' | 'storage' | 'too_large';
}

export interface Plan {
  options: ModeOption[];
  recommended: SaveMode | null;
  /** Catalog keys of warnings to show (large files on iOS, background tabs, low storage). */
  warnings: Array<'ios_keep_open' | 'mobile_background' | 'large_ios' | 'low_storage' | 'no_storage'>;
}

const GB = 1024 ** 3;

/** Which save modes work for `totalBytes` here, and what to warn about. Pure, so it is unit tested. */
export function planSave(c: Capabilities, totalBytes: number): Plan {
  // Folder and OPFS both stage blocks in OPFS, so both need the free space.
  const roomy = c.freeBytes === null || c.freeBytes >= totalBytes;
  const options: ModeOption[] = [
    {
      mode: 'folder',
      available: c.folder && c.opfs && roomy,
      ...(c.folder && c.opfs ? (roomy ? {} : { reason: 'storage' as const }) : { reason: 'unsupported' as const }),
    },
    {
      mode: 'opfs',
      available: c.opfs && roomy,
      ...(c.opfs ? (roomy ? {} : { reason: 'storage' as const }) : { reason: 'unsupported' as const }),
    },
  ];
  if (!c.opfs)
    options.push({
      mode: 'memory',
      available: totalBytes <= MEMORY_LIMIT,
      ...(totalBytes <= MEMORY_LIMIT ? {} : { reason: 'too_large' as const }),
    });
  const recommended = options.find((o) => o.available)?.mode ?? null;
  const warnings: Plan['warnings'] = [];
  if (c.ios) warnings.push('ios_keep_open');
  else if (c.mobile) warnings.push('mobile_background');
  if (c.ios && totalBytes > 2 * GB) warnings.push('large_ios');
  if (c.opfs && !roomy) warnings.push('low_storage');
  if (!c.opfs) warnings.push('no_storage');
  return { options, recommended, warnings };
}

export async function detectCapabilities(probe: () => Promise<boolean>, folder: () => boolean): Promise<Capabilities> {
  const b = browserFamily(navigator.userAgent);
  const opfs = await probe();
  let freeBytes: number | null = null;
  try {
    const e = await navigator.storage?.estimate?.();
    if (e?.quota !== undefined) freeBytes = Math.max(0, e.quota - (e.usage ?? 0));
  } catch {
    freeBytes = null;
  }
  return { ...b, folder: folder(), opfs, freeBytes };
}
