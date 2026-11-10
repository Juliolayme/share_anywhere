# Design System

How the Claude Design handoff becomes code. The design files in `design/claude-design/` are the source of truth for every visual decision (`CLAUDE.md`, UI source of truth). This document records how their values reach Web, Android, and iOS, which components exist, and the rules every screen follows. Where the design conflicts with a product decision, the PRD wins and the conflict is listed in `docs/design/DESIGN_DEVIATIONS.md`.

## 1. Sources and generation

| Design file | What it provides | Machine-readable copy | Generator |
|---|---|---|---|
| `Design System.dc.html` | Color tokens, type scale, spacing, radius, elevation, components and states, naming for Tailwind, Compose, SwiftUI | `shared/design/tokens.json` | `pnpm tokens` writes `web/src/styles/tokens.css` and `tokens.ts`; Kotlin (Phase 6) and Swift (Phase 7) targets are hooks in `scripts/gen-tokens.mjs` |
| `Web App.dc.html` CSS variables | Values for tokens the Design System names but does not list (soft and ink variants, `fg-3`, `border-strong`, `track`, `toast`, `scrim`, cloud violet) | same | same |
| `Logo.dc.html`, `Brand.dc.html` | Logo geometry, four color modes, icon specifications | `tokens.json` → `logo` | `pnpm brand` writes Web, Android, and iOS icons |
| `i18n-strings.json`, every `{en, vi}` table in the three app files (`T`, `VV`, `XX`, `YY`, `LBL`), the Handoff Checklist microcopy, and the hand-written `shared/i18n/product.json` for PRD strings the design lacks | EN/VI strings | `shared/i18n/en.json`, `vi.json` | `pnpm i18n` |
| `Screen Map.dc.html` and app `startScreen` options | Screen IDs | `docs/UX_SCREEN_MAP.md` | by hand |

CI fails if a generated file is stale (`pnpm tokens:check`, `pnpm brand:check`, `pnpm i18n:check`) or if a declared text color pair falls below WCAG AA in either theme.

### 1.1 Conflicts inside the design and how they were resolved

The Design System page wins over the prototypes' CSS when both give a value.

| Token | Design System | Web App CSS | Used |
|---|---|---|---|
| `receive-ink` (light) | `#0B7A3B` | `--greenInk #0B6B34` (Completed and P2P chips) | `#0B7A3B` |
| `warning` (light) | `#B25E00` | `--warn #F59E0B` | `#B25E00` for text and icons; `#F59E0B` is only the capacity-full fill (Phase 1 state tokens) |
| `e2` overlay | `0 8px 24px rgba(16,42,86,.12)` | `--shadow 0 8px 28px rgba(16,42,86,.14)` | Design System value |
| Warning banner text (light) | `warning-ink #8A4A00` (status chips) | Banner text `#6B3A00` | `warning-ink #8A4A00` everywhere (5.9:1 on `warning-soft`) |

### 1.2 Strings

- Catalog keys are namespaced by source: `common`, `phrases`, `web`, `web_vv`, `web_xx`, `web_yy`, `web_patterns`, `android*`, `ios*`, `handoff`, `product`. `<app>_patterns` holds the design's Vietnamese pattern translations (`TRP`) as templates with `{1}`, `{2}` placeholders; plural forms are the design's plural wording, and code that needs a singular form uses `Intl.PluralRules` with a separate key. Placeholder rule: `product` keys use named placeholders (`{name}`, `{n}`, `{time}`), `<app>_patterns` use positional ones (`{1}`, `{2}`); one formatting helper accepts an object for named and an array for positional values. `<app>_log` holds the native prototypes' connection-log lines; lines that carry sample values (TURN region, file counts, percentages) are used through the parameterized `product.log_*` keys.
- Some design strings carry prototype sample data (`common.ve_p` with an example email, `common.ve_resend` with "0:42", `web.joined` with "Minh", dated phrases) or are fragments meant to be concatenated (`android.expires` + `android.left`). Production code must not use them; it uses a parameterized key from `product` instead (for example `product.joined_session` with `{name}`, `product.join_within` with `{time}`). QA treats any of these sample-data keys in a production path as a defect.

## 2. Color tokens

Token names map 1:1 to Tailwind theme keys and to Compose and SwiftUI names. CSS variables are `--sa-<token>`. Dark mode uses lighter surface steps instead of shadows.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#F7FAFD` | `#0B1A33` | Canvas |
| `surface` | `#FFFFFF` | `#11223F` | Cards |
| `surface-2` | `#EEF3F9` | `#172C4D` | Raised, hover, inputs |
| `border` | `#DDE5EF` | `#233B60` | Dividers, card borders |
| `border-strong` | `#C9D5E4` | `#2F4A73` | Outlines (Compose `outline`) |
| `fg` | `#102A56` | `#EAF1FA` | Primary text |
| `fg-2` | `#4A5B78` | `#A9B8CF` | Secondary text |
| `fg-3` | `#6B7A93` | `#8496B2` | Tertiary text, large or non-essential only (3:1) |
| `send` | `#0A6FD6` | `#5AA9FF` | Brand blue for actions, links, filled buttons |
| `send-hover` | `#085DB4` | `#7BBBFF` | Hover and pressed |
| `send-soft` | `#EAF3FE` | `#15345E` | Tint backgrounds |
| `send-ink` | `#0A5FB8` | `#8EC3FF` | Text on `send-soft` |
| `on-send` | `#FFFFFF` | `#06182F` | Text on `send` |
| `receive` | `#16C75A` | `#3DDC84` | Brand green fills (never small text) |
| `receive-soft` | `#E7F8EE` | `#123D2E` | Green tint |
| `receive-ink` | `#0B7A3B` | `#5BE39A` | Green text |
| `on-receive` | `#06361A` | `#04210F` | Text on `receive` |
| `success` | `#0B7A3B` | `#5BE39A` | Alias of `receive-ink` |
| `info` | `#0A5FB8` | `#8EC3FF` | Alias of `send-ink` |
| `warning`, `warning-soft`, `warning-ink` | `#B25E00`, `#FFF4E0`, `#8A4A00` | `#FFB547`, `#3A2C12`, `#FFC870` | Warnings, partial states |
| `danger`, `danger-soft`, `danger-ink` | `#C62828`, `#FDECEC`, `#A11F1F` | `#FF7A7A`, `#3D1C24`, `#FF9C9C` | Errors, destructive actions |
| `cloud-soft`, `cloud-ink` | `#F1EDFD`, `#5B3CC4` | `#2A2352`, `#B9A6FF` | Cloud route badge |
| `focus` | `#0878E8` | `#8EC3FF` | Focus ring |
| `toast`, `toast-fg` | `#102A56`, `#FFFFFF` | `#EAF1FA`, `#102A56` | Toasts and snackbars |
| `track` | `#E3E9F1` | `#233B60` | Progress track |
| `scrim` | `rgba(16,42,86,.32)` | `rgba(3,10,22,.6)` | Dialog backdrop |

Brand colors (`brand.blue #0878E8`, `brand.green #16C75A`, `brand.navy #102A56`) are for the logo and illustrations. Small text and filled buttons use `send #0A6FD6` (4.8:1 on white).

Status is never color-only: every semantic color ships with an icon and a label.

## 3. Typography

| Style | Size / line | Weight | Family | Example |
|---|---|---|---|---|
| `display` | 40 / 48 | 700 | Plus Jakarta Sans | "Send files" hero |
| `headline` | 28 / 36 | 700 | Plus Jakarta Sans | Screen headline |
| `title` | 20 / 28 | 600 | Plus Jakarta Sans | Section title |
| `label-lg` | 16 / 24 | 600 | Plus Jakarta Sans | File names, buttons |
| `body` | 15 / 24 | 400 | Plus Jakarta Sans | Body copy |
| `caption` | 13 / 18 | 500 | Plus Jakarta Sans | Meta lines |
| `code` | 28 / 36 | 500 | JetBrains Mono | Six-digit code, hashes, sizes |

- Web self-hosts both fonts through `@fontsource` (OFL), so the CSP needs no third-party font origin.
- Android maps to `sp` and respects font scale up to 200 %: rows wrap and never truncate the action.
- iOS uses Plus Jakarta Sans 800 for large titles (`relativeTo: .largeTitle`) and SF Pro for body and controls so Dynamic Type works.

## 4. Spacing, radius, elevation, controls, breakpoints

- Spacing: 4-point grid; tokens `1`=4, `2`=8, `3`=12, `4`=16, `6`=24, `8`=32, `12`=48, `16`=64.
- Radius: `sm` 6, `md` 10, `lg` 14, `xl` 20, `full`. iOS uses continuous corners of 12, 14, 20.
- Elevation: `e0` = 1 px `border`; `e1` card = `0 1px 2px rgba(16,42,86,.08), 0 1px 3px rgba(16,42,86,.06)`; `e2` overlay = `0 8px 24px rgba(16,42,86,.12)`. Dark mode has no shadows.
- Focus ring: 2 px `focus` with 2 px offset.
- Control heights: Web `sm` 36, `md` 44, `lg` 52 (hero Send and Receive with a leading icon). Android 48 dp minimum, 56 dp hero. iOS 44 pt minimum.
- Web layout breakpoints: below 760 px a bottom bar, 760 to 1099 px an icon rail, 1100 px and above a sidebar. These replace the generic `sm 640 / md 768 / lg 1024 / xl 1280` list from the Phase 0 plan: Tailwind's `screens` are exactly `rail` (760 px) and `sidebar` (1100 px), and content inside a page uses fluid grids (`auto-fit`, `minmax`) as the design does. Recorded in `docs/design/DESIGN_DEVIATIONS.md` B10.

## 5. Icons

Lucide on Web (1.75 stroke), SF Symbols on iOS, Material Symbols Rounded on Android. Mapping from the Design System:

| Meaning | Lucide | SF Symbol | Material |
|---|---|---|---|
| Send | `arrow-up-right` | `arrow.up.right` | `north_east` |
| Receive | `arrow-down-left` | `arrow.down.left` | `south_west` |
| Clipboard | `clipboard` | `doc.on.clipboard` | `content_paste` |
| History | `clock` | `clock` | `history` |
| Devices | `monitor-smartphone` | `laptopcomputer.and.iphone` | `devices` |
| Settings | `settings` | `gearshape` | `settings` |
| Direct P2P | `zap` | `bolt.fill` | `bolt` |
| Relay | `radio-tower` | `antenna.radiowaves.left.and.right` | `cell_tower` |
| Verified | `shield-check` | `checkmark.shield` | `verified_user` |
| Remove receiver | `user-x` | `person.badge.minus` | `person_remove` |
| Paused in background | `moon` | `moon.zzz` | `bedtime` |
| Folder | `folder` | `folder` | `folder_open` |
| Share | `share` | `square.and.arrow.up` | `share` |

## 6. Components

Every component implements default, hover, pressed, focus, disabled, loading, and error where they apply. The Design System gives light-mode state colors that are not tokens yet (primary pressed `#064D96`, ghost pressed `#D6E8FD`, secondary pressed `#E5ECF5`, destructive hover and pressed `#A82020` / `#8E1B1B`, destructive disabled `#F0E3E3` / `#B79A9A`, secondary hover border and fill `#AFC0D6` / `#F1F5FA`, disabled `#E3E9F1` / `#8A97AC` / `#A3AFC2`, disabled input `#F3F6FA`, selected card `#F5F9FF`, skeleton shimmer `#BDEFD0`, input focus halo `rgba(8,120,232,.22)`, capacity-full fill `#F59E0B`, iOS grouped background `#F2F5FA`). Phase 1 adds them as tokens, with dark values, before building Button and Input. Native apps use Material 3 components on Android and system SwiftUI controls on iOS, styled with these tokens.

| Component | Variants and states | Web name | First phase |
|---|---|---|---|
| Button | primary, secondary, ghost, destructive; `sm`/`md`/`lg`; loading label (`product.creating`) | `<Button variant size loading/>` | 1 |
| Input | default, focus, error with message, disabled | `<TextField/>` | 1 |
| OTP six-digit input | default, filled, focus, error (`common.nf_rx`, `common.cx_rx`) | `<CodeInput/>` | 2 |
| Card, Toast / Snackbar, Dialog / Alert, Bottom sheet, Empty state, Skeleton, Permission banner, Tabs / Segmented, Search and filter bar, Switch | per Design System page | same names | 1 |
| Sidebar / Rail / Bottom nav (Web); bottom navigation (Android); tab bar (iOS) | active, inactive, focus | `<AppNav/>` | 1 |
| Identity chip | Guest + Sign in (Sign in hidden until Phase 5A), account menu | `<IdentityChip/>` | 1 |
| Guest / Signed in badge | "Guest" (neutral `surface-2` / `fg-2`, user icon), "Signed in" (`send-soft` / `send-ink`, shield icon) next to a peer's device name | `<IdentityBadge kind/>` | 2 |
| Account-required intro | informational, never an error: icon, headline, two-sentence benefit, privacy line, Sign in and Create account; used by the Clipboard tab, Devices account section, disabled Settings rows | `<AccountRequiredIntro/>` | 5A |
| Require approval toggle | Switch with label and state description ("Off · anyone with a valid code joins" / "On · you approve each receiver"), on the review screen, the session screen, and Settings › Transfer (default for new sessions) | `<RequireApprovalSwitch/>` | 2 |
| Keep-open banner | sticky on sending, receiving, waiting screens: "Keep Share Anywhere open — don't close it so the transfer continues." with the screen-on pill at its end | `<KeepOpenBanner/>` | 2 |
| Screen-on pill | one component for every keep-screen-on status; states, strings, and tap behavior are defined once in `docs/ARCHITECTURE.md` §7.3 | `<ScreenOnPill/>` | 2 |
| QR panel, six-digit code with 10:00 countdown, code expired state | valid, under one minute (stays calm, no red), expired with Create new code | `<SharePanel/>` | 2 |
| Security words | same three words on sender and receiver | `<SecurityWords/>` | 2 |
| Capacity five-segment | `product.capacity` ("{joined}/5 receivers · {left} slots left"), `product.capacity_full` | `<Capacity/>` | 2 |
| Participant card | auto-joined receiver (default): device name, platform, Guest/Signed in badge, security words, status, **Remove** and **Block** (Block is a PRD addition, `DESIGN_DEVIATIONS.md` E1); join request (approval on) with Approve / Reject / Block; removed and blocked end states | `<ParticipantCard/>` | 2 |
| File row | name, type, size; reading metadata | `<FileRow/>` | 2 |
| Route badge | Direct P2P, Relay, Cloud, Finding route… | `<RouteBadge route/>` | 3 |
| Status chip | connecting, transferring, paused, reconnecting, verifying, completed, partial, failed, removed, cancelled, budget | `<StatusChip status/>` | 3 |
| Progress bar / ring | determinate with speed and ETA; "Estimating time…" until more than 3 %; paused; verifying | `<Progress/>` | 3 |
| Cloud consent | size, bandwidth, retention, cost, budget | `<CloudConsent/>` | 8 |
| Lock-screen notification (iOS) | "Transfer paused — reopen the app to resume" | native | 7 |

Reduced motion disables shimmer and progress sweeps; values update stepwise.

## 6b. Form validation patterns

From the Design System Input and OTP specimens:

- Labels are always visible above the field; placeholders never replace labels.
- Validate on blur and on submit, not on every keystroke; once a field has shown an error, re-validate on input so the error clears as soon as it is fixed.
- Error state: `danger` border and ring, an icon plus a one-line message below the field (`product.email_invalid`), linked with `aria-describedby` and announced with `aria-invalid="true"`.
- The six-digit code input accepts digits only, supports paste of the whole code, moves focus forward and backward automatically, and shows one error for the whole group (`common.nf_rx`, `common.cx_rx`).
- Submit buttons show a loading label (`product.creating`, `product.joining`) and stay disabled until the form is valid; server errors appear inline above the button, never only in a toast.
- Rate limits show the wait time from `Retry-After` (`product.rate_limited`).

## 7. Accessibility rules

- Text tokens meet 4.5:1 on their surfaces, checked by `pnpm tokens:check`; `fg-3` is limited to large or non-essential text (3:1 on `bg`, `surface`, `surface-2`). Text on `send-soft` uses `send-ink`, never `send` (4.4:1).
- Status always has an icon and a label in addition to color.
- Focus is always visible (2 px ring, 2 px offset); dialogs trap and restore focus.
- Touch targets: 44 px Web, 48 dp Android, 44 pt iOS, through padding when the visual is smaller.
- Respect reduced motion and system font scaling.
- Icon-only buttons have accessible names; decorative logos are hidden from assistive technology.
- `border` and `border-strong` do not reach 3:1 against surfaces, so inputs and controls must not rely on their border alone: they carry a visible label and the `surface-2` fill or a focus ring (`docs/design/DESIGN_DEVIATIONS.md`).

## 8. Brand guide

- The `Logo` component follows the theme by default (`mode="auto"`): the color lockup on light surfaces and the reverse lockup on dark ones, through `--sa-logo-*` variables; the wordmark contrast is checked in both themes.
- Mark: "Passing lanes" — two capsules passing each other with a dot on each lane's leading edge; blue sends, green receives.
- Color modes: `color` (blue `#0878E8`, green `#16C75A`, white dots, navy text), `dark` (blue `#2D8DF2`, green `#22D468`, navy dots, white text), `mono-dark`, `mono-light`.
- Wordmark: Plus Jakarta Sans 700, letter spacing −0.025em, font size 0.52 × symbol, gap 0.24 × symbol.
- Clear space: one capsule height (a quarter of the symbol height) on all sides.
- Minimum size: symbol 16 px; lockup 24 px high and 120 px wide. At 16 px and below use the dotless variant (the 16 px favicon and the SVG favicon); below 24 px use the symbol alone.
- Do not stretch, rotate, recolor, mirror or swap lanes, add effects, or place on busy backgrounds.
- Icons: Android adaptive icon with a navy background and the `dark` symbol at 52 of 108 dp inside the 66 dp safe zone, plus a monochrome layer for themed icons; Web PWA icons (white rounded and navy maskable), favicons at 16 (dotless), 32, and 48 px plus standalone 16 and 32 px PNGs; iOS one opaque 1024 px PNG without an alpha channel per appearance (navy, black, tinted) with the symbol inside the central 62 %. The maskable PWA icon uses the design's 64/96 scale.
- Generated assets live in `web/public/`, `android/app/src/main/res/`, and `ios/ShareAnywhere/Assets.xcassets/`. The development page `/brand` renders the lockups and every token.
