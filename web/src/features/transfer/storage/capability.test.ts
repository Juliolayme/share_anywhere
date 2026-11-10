import { describe, expect, it } from 'vitest';
import { browserFamily, planSave, type Capabilities } from './capability';

const GB = 1024 ** 3;
const base: Capabilities = {
  family: 'chromium',
  mobile: false,
  ios: false,
  folder: true,
  opfs: true,
  freeBytes: 100 * GB,
};

describe('browserFamily', () => {
  it.each([
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'chromium',
      false,
      false,
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      'chromium',
      true,
      false,
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'firefox', false, false],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'safari',
      false,
      false,
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'safari',
      true,
      true,
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
      'safari',
      true,
      true,
    ],
  ])('%s', (ua, family, mobile, ios) => {
    expect(browserFamily(ua)).toEqual({ family, mobile, ios });
  });
});

describe('planSave (PRD §6.8)', () => {
  it('Chromium desktop: folder recommended, browser storage available, no warnings', () => {
    const p = planSave(base, 5 * GB);
    expect(p.recommended).toBe('folder');
    expect(p.options.map((o) => [o.mode, o.available])).toEqual([
      ['folder', true],
      ['opfs', true],
    ]);
    expect(p.warnings).toEqual([]);
  });

  it('Firefox: no folder picker, browser storage recommended', () => {
    const p = planSave({ ...base, family: 'firefox', folder: false }, GB);
    expect(p.recommended).toBe('opfs');
    expect(p.options[0]).toEqual({ mode: 'folder', available: false, reason: 'unsupported' });
  });

  it('iOS Safari: keep-open warning, and a large-file warning above 2 GB', () => {
    const p = planSave({ ...base, family: 'safari', folder: false, mobile: true, ios: true }, 3 * GB);
    expect(p.recommended).toBe('opfs');
    expect(p.warnings).toEqual(['ios_keep_open', 'large_ios']);
  });

  it('not enough storage: both storage modes refused with the reason', () => {
    const p = planSave({ ...base, freeBytes: GB }, 2 * GB);
    expect(p.recommended).toBeNull();
    expect(p.options.every((o) => o.reason === 'storage')).toBe(true);
    expect(p.warnings).toContain('low_storage');
  });

  it('no storage (private window): memory up to 256 MB only', () => {
    const small = planSave({ ...base, folder: false, opfs: false, freeBytes: null }, 100 * 1024 * 1024);
    expect(small.recommended).toBe('memory');
    expect(small.warnings).toContain('no_storage');
    const big = planSave({ ...base, folder: false, opfs: false, freeBytes: null }, 300 * 1024 * 1024);
    expect(big.recommended).toBeNull();
    expect(big.options.find((o) => o.mode === 'memory')).toEqual({
      mode: 'memory',
      available: false,
      reason: 'too_large',
    });
  });

  it('mobile Chromium warns about background tabs', () => {
    expect(planSave({ ...base, mobile: true }, GB).warnings).toEqual(['mobile_background']);
  });
});
