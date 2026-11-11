# ADR 0018: Android dependency injection, persistence, secret storage, and build reproducibility

Status: Accepted (Phase 6, milestone 6.1, 2026-11-11)

## Context

Milestone 6.1 builds the Android foundation: guest-first shell, anonymous device identity, local History, Settings (`docs/phases/PHASE_6_ANDROID.md`). `CLAUDE.md` §5 pins Kotlin 2.x, the Compose BOM, AGP 8.x, JDK 17, minSdk 26, targetSdk 35, and requires pinned versions with lockfiles. `docs/SECURITY_MODEL.md` §4 requires the refresh secret in Keystore-backed storage.

## Decision

**Dependency injection: Hilt** (with KSP). One `AppModule` provides the configuration, OkHttp, the API client, the identity manager, Room, and DataStore as singletons; screens get view models through `hiltViewModel()`. Instrumentation tests drive the real app and reach singletons through `AppEntryPoint` instead of a Hilt test application, so the tested graph is the shipped one.

**Persistence.**

- Local History: **Room** (`share-anywhere-history.db`), schema exported to `android/app/schemas/` for migrations. The entry mirrors the Web entry field for field (`web/src/features/history/store/history-store.ts`), enums stored by their Web wire names, lists as JSON, so cloud history sync (6.4) carries the same JSON. Deleted ids are remembered for 7 days (at most 500), as on the Web. Retention values (30, 90 days, none) and their stored strings match the Web. The resume bitmap (6.3) will live in the same database.
- Settings: **DataStore Preferences** (`settings.preferences_pb`): welcomed, theme, language, keep screen on (default on), history retention. None of them is secret.
- **Refresh secret: our own AndroidKeyStore wrapper**, not `EncryptedSharedPreferences` (deprecated with `security-crypto`). `KeystoreSecretStore` keeps an AES-256-GCM key in AndroidKeyStore (never exported, random IV per write, AAD naming the purpose and package) and writes the ciphertext atomically to `noBackupFilesDir`. Backups and device-to-device transfer exclude app data (`allowBackup="false"`, `data_extraction_rules.xml`). A blob that does not decrypt is deleted, which leads to a new anonymous identity. The access token exists only in `IdentityManager`'s memory.

**Build.**

- AGP 8.13.2, Kotlin 2.2.21 (KSP 2.2.21-2.0.5), Gradle 8.14.3 through the committed wrapper with `distributionSha256Sum`; CI validates the wrapper jar (`gradle/actions/wrapper-validation`).
- **compileSdk 35**, equal to targetSdk. AndroidX versions are the last that build against API 35 (Compose BOM 2025.06.01, core 1.16, activity 1.10, lifecycle 2.9, navigation 2.9, Room 2.7); moving to newer AndroidX means raising compileSdk in a later ADR, not only bumping versions.
- JDK: Java and Kotlin target 17 (`jvmTarget`, `sourceCompatibility`), no Gradle toolchain, so CI's JDK 17 and newer local JDKs build the same bytecode without downloading a toolchain.
- **Dependency locking** of every configuration (`app/gradle.lockfile`, `buildscript-gradle.lockfile`, `settings-gradle.lockfile`); refresh with `./gradlew :app:dependencies buildEnvironment --write-locks`.
- Reproducible debug APKs: no build timestamps or VCS data in `BuildConfig`, dependency metadata not embedded (`dependenciesInfo`), locked dependencies. Debug builds are signed with the machine's debug key, so signatures differ between machines while the contents do not. No release signing configuration is in the repository.
- **ktlint** (`org.jlleitschuh.gradle.ktlint`, Android Studio style, `.editorconfig`) runs in the `android` job; generated files are excluded.
- **Robolectric** for Room and resource tests on the JVM. Its Android framework jar (`android-all-instrumented`, about 200 MB) is resolved by Gradle into a locked configuration and passed to Robolectric with `robolectric.offline`, so it is cached with the other dependencies and never downloaded by Robolectric itself.
- Build-time feature flags in `BuildConfig` (`FLAG_SHARING`, `FLAG_ACCOUNTS`, `FLAG_CLIPBOARD`), all off in 6.1 (`CLAUDE.md` §8b); `FlagsTest` fails if one is turned on before its milestone changes the test.
- WorkManager is not added in 6.1: nothing needs deferred work yet (clipboard sync and cleanup arrive in later milestones).

## Consequences

- A dependency change needs `--write-locks` and a review of the lockfile diff.
- Fonts: Plus Jakarta Sans (OFL, variable weight, about 170 KB) is bundled so the design's typeface renders on every device; JetBrains Mono is not bundled and the platform monospace stands in (`docs/design/DESIGN_DEVIATIONS.md` section I).
