# ADR 0005: Browser capability policy

Status: Accepted (Phase 0, 2026-11-10)

## Context

PRD §2 sets browser support by the §6.8 capability matrix. Browsers differ widely in how they can receive large files, read the clipboard, and keep the screen on (PRD §6.8, §7.2, §5.10). Pretending otherwise leads to failed 20 GB transfers and broken promises.

## Decision

- The Web client detects capabilities at runtime and shows the honest outcome before a transfer starts: File System Access API on Chromium, OPFS plus Service Worker streaming elsewhere, refusal with an explanation when a file cannot be received safely.
- Clipboard reads happen only from user gestures or permitted focus events, never by polling; guests never touch clipboard APIs.
- Keeping the screen on uses the Screen Wake Lock API when available and a visible reminder otherwise; no hidden-video workarounds.
- A capability counts as tested only when a Playwright project or a real browser run has exercised it. Locally only Chromium is installed; Firefox, WebKit, and the iPhone profile run in CI.

## Consequences

- The capability matrix in PRD §6.8 is maintained as tests land.
- Mobile Safari users may be told a very large file cannot be received in the browser and offered the iOS app instead.
