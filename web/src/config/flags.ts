// Build-time feature flags (CLAUDE.md §8b). A flag turns on only in the phase that makes the feature work:
// `sharing` in Phase 2, `accounts` in Phase 5A, `clipboard` in Phase 5B. Set VITE_FLAG_<NAME>=true to build
// with a flag on; tests override with vi.mock.
export interface Flags {
  sharing: boolean;
  accounts: boolean;
  clipboard: boolean;
}

const env = import.meta.env as Record<string, string | undefined>;

export const flags: Flags = {
  sharing: env.VITE_FLAG_SHARING === 'true',
  accounts: env.VITE_FLAG_ACCOUNTS === 'true',
  clipboard: env.VITE_FLAG_CLIPBOARD === 'true',
};
