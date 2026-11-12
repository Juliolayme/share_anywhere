# Release checklist

Run it for every release. Items marked **[done]** were completed for the first release candidate on this branch (with the evidence named on the item) and are re-checked each time; unmarked items need a person with the store accounts, signing keys, a public server, or real devices. Nothing here contains a key, certificate or password, and none may be committed (`CLAUDE.md` §3.10, §7).

## 1. Code and CI

- [ ] Required checks green on the release commit (record the CI run link here): `backend`, `web`, `e2e-web` (five projects), `protocol`, `security`, `a11y`, `android`, `android-emulator`, `ios`, `ios-simulator` (`docs/TESTING_AND_CI.md`).
- [ ] Latest Nightly green or each failure triaged (record the run link): `large-file`, `turn-forced`, `five-receivers`, `chaos`, `abuse-soak`, `visual`, `throughput`, the Android API 29/35 matrix, the iOS device matrix, interop jobs.
- [x] **[done]** Security review current (`docs/qa/PHASE_9_SECURITY_REVIEW.md`): `govulncheck`, `pnpm audit`, Trivy image scan and gitleaks over the full history triaged.
- [ ] **Release blocker — open-source notices.** The apps bundle third-party code whose licences require attribution in binary distributions (the WebRTC binaries under BSD, the vendored Argon2 reference code, Go, npm, Gradle and SwiftPM dependencies). A notices screen (design F7, Settings → Licenses) and generated notice files for each platform are not built yet (`KNOWN_LIMITATIONS.md` §6).
- [ ] Version bumped consistently: Web `package.json` `version`, Android `versionCode` / `versionName` (`android/app/build.gradle.kts`), iOS `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` (`ios/project.yml`); tag `vX.Y.Z` on the release commit.
- [ ] `KNOWN_LIMITATIONS.md` reviewed for the release; user-facing release notes written from it.

## 2. Server

- [ ] Deployed with `docs/runbooks/deploy.md`; `/readyz` green; a guest transfer between two networks works, and a forced-relay one shows "Using relay".
- [ ] Backups scheduled and one restore drill done (`docs/runbooks/backup-restore.md`).
- [ ] `/.well-known/assetlinks.json` serves the **release** signing certificate's SHA-256 (`SA_ANDROID_CERT_SHA256`, `docs/runbooks/android-app-links.md`); `/.well-known/apple-app-site-association` serves `SA_APPLE_APP_ID`.
- [ ] CSP and security headers checked on the public domain (`curl -sI https://<domain>/`), HTTPS only, HSTS on.
- [ ] Privacy policy and support page published (both stores require their URLs).

## 3. Android (Google Play)

### Signing (no keys in the repository)

- The repository has no signing config: `release` builds are unsigned (`android/app/build.gradle.kts`). Use **Play App Signing**: Google holds the app signing key; you keep an **upload key**.
- Create the upload key once, outside the repository, and keep it and its passwords in a password manager:

```bash
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
```

- Build and sign:

```bash
cd android && ./gradlew :app:bundleRelease -PreleaseBackend=https://<domain>
```

```bash
jarsigner -keystore /secure/upload.jks android/app/build/outputs/bundle/release/app-release.aab upload
```

- After the first upload, copy the **app signing** certificate's SHA-256 from Play Console (Setup → App signing) into `SA_ANDROID_CERT_SHA256` so App Links verify.
- [ ] Bundle signed with the upload key; R8 release build smoke-tested on a device (`docs/TESTING_AND_CI.md` §2.1 lists what the emulator does not cover).

### Play policy

- [ ] **Foreground service type `dataSync`** (`TransferService`, Android 14+ declaration form): sending and receiving files that the user starts; it runs only while a transfer is active and stops when it ends; Android 15's daily `dataSync` budget is handled by `onTimeout` (transfers pause with a notice). Attach a short video of a transfer with the notification.
- [ ] **Permissions:** `CAMERA` (QR scanning, only while the scanner is open), `POST_NOTIFICATIONS` (transfer progress), `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`, `WAKE_LOCK` (the transfer service's partial wake lock so the CPU keeps moving bytes with the screen off; keeping the screen on uses the window flag and needs no permission), `INTERNET`. No storage permission: files are picked and saved through the system picker and MediaStore.
- [ ] **Clipboard:** read only while the app is in front, after the user signed in and turned Clipboard Sync on; sensitive clips skipped; no background reading; content end-to-end encrypted. State this in the store listing and the Data safety form.
- [ ] **Data safety form:** collected — email address (account, optional, app functionality), device or other IDs (anonymous installation ID, app functionality); not collected — files, clipboard contents and history (end-to-end encrypted, the developer cannot read them); data encrypted in transit; account deletion — **blocked, see below**.
- [ ] **Release blocker — account deletion.** Play requires apps that let users create an account to offer account deletion in the app and through a web link. Not built on any platform (no endpoint, no screen in the design handoff; `KNOWN_LIMITATIONS.md` §6). Needs a product and design decision (what is deleted, grace period, effect on signed-in devices) and an implementation phase before submission.
- [ ] Content rating questionnaire (file sharing between users: user-to-user content), target audience (not for children), ads: none.
- [ ] `targetSdk 35` meets the current Play target-API requirement.

## 4. iOS (App Store / TestFlight)

### Signing and provisioning (no certificates in the repository)

- `DEVELOPMENT_TEAM` is empty in `ios/project.yml` and simulator builds are signed ad hoc. For device builds, set the Team ID at build time rather than committing it:

```bash
cd ios && xcodegen generate
```

```bash
xcodebuild archive -project ios/ShareAnywhere.xcodeproj -scheme ShareAnywhere -configuration Release -destination generic/platform=iOS -archivePath build/ShareAnywhere.xcarchive DEVELOPMENT_TEAM=<TEAMID> CODE_SIGN_STYLE=Automatic SA_BACKEND_URL=https://<domain> SA_PUBLIC_URL=https://<domain> SA_APPLINKS_HOST=<domain>
```

- In the Apple Developer account: App ID `app.shareanywhere` with the **Associated Domains** capability (Release entitlements file `ShareAnywhere-Release.entitlements`, `applinks:$(SA_APPLINKS_HOST)`); distribution certificate and App Store provisioning profile managed by Xcode (automatic signing) or fastlane match in a private store — never in this repository.
- Export and upload with Xcode Organizer or `xcodebuild -exportArchive` with an `ExportOptions.plist` (`method: app-store-connect`), then `xcrun altool`/Transporter.
- [ ] TestFlight internal build installed on a real iPhone; `docs/runbooks/ios-real-device-checklist.md` run end to end and the result recorded.

### App Review

- [ ] **Background:** no `UIBackgroundModes` are declared. Transfers pause when the app goes to the background and resume on return (a local notification tells the user); no audio, VoIP or location tricks keep the app alive. Review notes say so.
- [ ] **Clipboard:** read only in the foreground, through the system Paste control or the user's tap on Sync (which shows iOS's paste prompt), only for signed-in users who turned Clipboard Sync on; never read in the background; end-to-end encrypted. Review notes include a demo account with Clipboard Sync set up.
- [ ] **Files:** files are picked with the system document picker and saved to the app's Documents folder (visible in Files: `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`) or to a folder the user picks; sharing works without an account (guest-first; review notes explain how to test with two devices or the Web app).
- [ ] **Camera:** `NSCameraUsageDescription` explains QR scanning only.
- [ ] **Privacy manifest** `PrivacyInfo.xcprivacy` (CI checks it is in the bundle): no tracking; email address and device ID collected, both linked to the user (a signed-in device is tied to its account) and used for app functionality only; `UserDefaults` required-reason API with reason `CA92.1`. Check the WebRTC binary package's own manifest when bumping it. App Store Connect privacy answers match the manifest.
- [ ] **Export compliance:** `ITSAppUsesNonExemptEncryption` is `false` in `Info.plist`. The app uses standard encryption (TLS, DTLS for WebRTC, AES-GCM and X25519 through CryptoKit and system libraries, and Argon2id from the vendored reference implementation `CArgon2`) for user data protection, which is usually exempt, but **confirm with legal before the first submission** and change the key and the App Store Connect answer if they decide otherwise (an annual self-classification report may be required).
- [ ] **Release blocker — account deletion.** App Review guideline 5.1.1(v) requires in-app account deletion for apps with sign-up. Not built (see the Play item in §3).
- [ ] Screenshots: the 6.9" set is required (the CI screenshot suite runs on iPhone 16 Pro Max, 6.9"); the iPhone SE run gives 4.7" images if older sizes are wanted (`docs/phases/reports/assets/`).

## 5. After release

- [ ] Watch `/readyz`, error logs and the `sa_` metrics for 48 hours (`docs/runbooks/incident-basics.md`).
- [ ] Record the release, its commit and the tag in the operations log.
