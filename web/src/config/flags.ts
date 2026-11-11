// Build-time feature flags (CLAUDE.md §8b). A flag turns on only in the phase that makes the feature work:
// `sharing` in Phase 2 (on), `accounts` in Phase 5A (on), `clipboard` in Phase 5B. Flags that are on build with
// the feature unless VITE_FLAG_<NAME>=false; the clipboard flag needs VITE_FLAG_CLIPBOARD=true. Tests override
// with vi.mock or the providers' `enabled` props.
export interface Flags {
  sharing: boolean;
  accounts: boolean;
  clipboard: boolean;
}

const env = import.meta.env as Record<string, string | undefined>;

export const flags: Flags = {
  // On since Phase 2 (share sessions and joining work end to end); VITE_FLAG_SHARING=false builds without it.
  sharing: env.VITE_FLAG_SHARING !== 'false',
  // On since Phase 5A (sign in, account Devices list, history sync); VITE_FLAG_ACCOUNTS=false builds without it.
  accounts: env.VITE_FLAG_ACCOUNTS !== 'false',
  clipboard: env.VITE_FLAG_CLIPBOARD === 'true',
};
