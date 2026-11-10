// Build-time feature flags (CLAUDE.md §8b). A flag turns on only in the phase that makes the feature work:
// `sharing` in Phase 2 (on), `accounts` in Phase 5A, `clipboard` in Phase 5B. Set VITE_FLAG_<NAME>=true to
// build with a flag on (or VITE_FLAG_SHARING=false to build without sharing); tests override with vi.mock.
export interface Flags {
  sharing: boolean;
  accounts: boolean;
  clipboard: boolean;
}

const env = import.meta.env as Record<string, string | undefined>;

export const flags: Flags = {
  // On since Phase 2 (share sessions and joining work end to end); VITE_FLAG_SHARING=false builds without it.
  sharing: env.VITE_FLAG_SHARING !== 'false',
  accounts: env.VITE_FLAG_ACCOUNTS === 'true',
  clipboard: env.VITE_FLAG_CLIPBOARD === 'true',
};
