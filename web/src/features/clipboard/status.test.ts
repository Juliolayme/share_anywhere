// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveCaptureStatus, mayAutoRead, mayCaptureCopy, type CaptureInputs } from './status';

const base: CaptureInputs = {
  secure: true,
  hasRead: true,
  permission: 'prompt',
  autoCapture: true,
  online: true,
  paused: false,
};
const s = (over: Partial<CaptureInputs>) => deriveCaptureStatus({ ...base, ...over });

describe('capture status (docs/UX_SCREEN_MAP.md §12 clipboardStatus)', () => {
  it('derives each state from capability detection, the toggle, the network and the account setting', () => {
    expect(s({ permission: 'granted' })).toBe('auto');
    expect(s({ permission: 'prompt' })).toBe('besteffort');
    expect(s({ permission: 'granted', autoCapture: false })).toBe('besteffort');
    expect(s({ permission: 'denied' })).toBe('denied');
    // Firefox and Safari expose no clipboard-read permission state: every read needs a click.
    expect(s({ permission: 'unsupported' })).toBe('unsupported');
    expect(s({ hasRead: false, permission: 'granted' })).toBe('unsupported');
    expect(s({ online: false, permission: 'granted' })).toBe('offline');
    expect(s({ paused: true, online: false })).toBe('paused');
    expect(s({ secure: false, paused: true })).toBe('insecure');
  });

  it('allows automatic reads only when permission is already granted and the toggle is on (never prompting)', () => {
    expect(mayAutoRead({ ...base, permission: 'granted' })).toBe(true);
    for (const over of [
      { permission: 'prompt' as const },
      { permission: 'denied' as const },
      { permission: 'unsupported' as const },
      { permission: 'granted' as const, autoCapture: false },
      { permission: 'granted' as const, paused: true },
      { permission: 'granted' as const, secure: false },
    ])
      expect(mayAutoRead({ ...base, ...over })).toBe(false);
    // Offline, an automatic capture is still read, encrypted and queued.
    expect(mayAutoRead({ ...base, permission: 'granted', online: false })).toBe(true);
  });

  it('captures in-page copies only when the panel says automatic or best-effort with the toggle on', () => {
    expect(mayCaptureCopy({ ...base, permission: 'granted' })).toBe(true); // auto
    expect(mayCaptureCopy({ ...base, permission: 'prompt' })).toBe(true); // besteffort, toggle on
    expect(mayCaptureCopy({ ...base, permission: 'granted', online: false })).toBe(true); // queued offline
    for (const over of [
      { permission: 'granted' as const, autoCapture: false }, // "Manual capture"
      { permission: 'prompt' as const, autoCapture: false },
      { permission: 'denied' as const }, // "Clipboard permission denied"
      { permission: 'unsupported' as const }, // Firefox, Safari: "can't read the clipboard automatically"
      { permission: 'granted' as const, hasRead: false },
      { permission: 'granted' as const, paused: true },
      { permission: 'granted' as const, secure: false },
    ])
      expect(mayCaptureCopy({ ...base, ...over })).toBe(false);
  });
});
