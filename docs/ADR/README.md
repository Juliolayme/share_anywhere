# Architecture Decision Records

Each ADR records one decision: context, decision, consequences. ADRs are never edited after acceptance except to mark them superseded or amended by a later ADR; a change of mind is a new ADR.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo-and-toolchain.md) | Monorepo layout and toolchain pins | Accepted |
| [0002](0002-guest-first-identity-model.md) | Guest-first identity model | Accepted |
| [0003](0003-client-owned-route-strategy.md) | Clients own route selection | Accepted |
| [0004](0004-clipboard-key-bootstrap.md) | Account Data Key bootstrap | Accepted |
| [0005](0005-browser-capability-policy.md) | Browser capability policy | Accepted |
| [0006](0006-android-sdk-and-fgs-limits.md) | Android SDK levels and foreground-service limits | Accepted |
| [0007](0007-goose-migrations.md) | Database migrations with goose | Accepted |
| [0008](0008-device-token-format.md) | Device access token format and lifetimes | Accepted |
| [0009](0009-argon2id-passwords.md) | Argon2id parameters for account passwords | Accepted |
| [0010](0010-account-sessions.md) | Account sessions layered on device identity | Accepted, partly superseded by 0013 |
| [0011](0011-refresh-reuse-grace.md) | Grace window for the previous refresh secret | Accepted, partly superseded by 0013 |
| [0012](0012-key-authenticity.md) | Key authenticity for account key versions and device wrapping keys | Accepted, amended by 0014 |
| [0013](0013-session-hardening.md) | Account session hardening (browser-session binding, retired refresh secrets) | Accepted |
| [0014](0014-current-version-proofs.md) | Current-version key proofs, rotation owed after departures, and pairing anchored on held keys | Accepted, amended by 0015 |
| [0015](0015-authenticated-recovery-key.md) | Authenticated recovery key and key checks in open tabs | Accepted |
| [0016](0016-android-networking.md) | Android networking and API models | Accepted |
| [0017](0017-android-webrtc.md) | WebRTC library for Android | Accepted |
| [0018](0018-android-di-persistence-build.md) | Android dependency injection, persistence, secret storage, and build reproducibility | Accepted |
| [0019](0019-android-qr.md) | QR codes on Android (generation and scanning) | Accepted |
| [0020](0020-android-background-transfers.md) | Android background transfers (foreground service, not user-initiated data transfer jobs) | Accepted |
