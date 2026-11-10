# ADR 0002: Guest-first identity model

Status: Accepted (Phase 0, 2026-11-10)

## Context

File sharing must work immediately for anyone, with no account (PRD §2 "Guest-first file sharing"). Some features need an account so devices can find each other: Clipboard Sync, the account-wide Devices list, cloud history, and Cloud Distribution as a sender. The server still needs a verifiable identity for every caller to authorize sessions, apply rate limits, and issue TURN credentials.

## Decision

- Every installation or browser profile gets an **anonymous device identity** from `POST /v1/devices/anonymous`: a device ID, a 15-minute Ed25519-signed access token, and a rotating refresh secret with reuse detection (`docs/SECURITY_MODEL.md` §4).
- An account session is **layered on** the device identity: signing in adds an `acct` claim (and `dl` when the device is added) without changing the device ID, so transfers in progress continue.
- Only Clipboard Sync, the account Devices list, cloud history, and Cloud Distribution as a sender require an account. Cloud Distribution requires a signed-in sender for cost attribution, budget caps, and storage-abuse control; guest receivers may download from sessions they joined.
- Signing out issues a new anonymous identity so later guest activity cannot be linked to the account.
- Accounts are built in Phase 5A; until then the `accounts` flag hides every sign-in entry point (`CLAUDE.md` §8b).

## Consequences

- Sessions are owned by a device (`owner_device_id`), and `user_id` is never required for file sharing (`docs/ARCHITECTURE.md` §8).
- Abuse controls must key on IP and device, not on accounts (`docs/SECURITY_MODEL.md` §5).
- Adding any account requirement to a Transfer flow is a product change that needs a new ADR.
