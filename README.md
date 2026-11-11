# Share Anywhere

Cross-platform peer-to-peer file sharing and clipboard sync for Web, Android, and iOS. File sharing is guest-first: no account is needed to send or receive. Only Clipboard Sync and a few account-wide features require signing in.

Status: **Phases 0 to 5 done on the Web and backend; Phase 6 (Android) in progress** (milestone 6.1: guest-first shell, anonymous identity, local History, Settings). See `docs/phases/README.md` for the plan and `docs/phases/reports/` for what has actually been built and tested.

## Where things are

| Path | What |
|---|---|
| `CLAUDE.md` | Standing engineering rules |
| `CLAUDE_DESIGN_AND_BUILD_PROMPT.md` | How to run a phase, document map |
| `design/claude-design/` | Claude Design handoff, the UI source of truth (imported in Phase 0) |
| `docs/` | Requirements, architecture, screen map, security model, API, testing strategy, ADRs, phase plans and reports |
| `backend/` | Go backend (modular monolith) |
| `web/` | React + TypeScript web app |
| `android/` | Native Android app (Kotlin, Jetpack Compose), Gradle project |
| `shared/design/tokens.json` | Design tokens; `pnpm tokens` generates platform files |
| `infra/` | coturn and Caddy configuration |

## Quick start (Docker Compose)

Requirements: Docker with Compose v2.

```bash
cp .env.example .env
```

```bash
docker compose up --build
```

Then open <https://localhost:8443> and accept the local certificate (Caddy's internal CA). Health checks: `https://localhost:8443/healthz` and `https://localhost:8443/readyz`.

## Local development without Docker

Requirements: Go 1.27, Node 22, pnpm 10.28 (`npm install -g pnpm@10.28.0`), and optionally PostgreSQL 16.

```bash
pnpm install
```

```bash
cd backend && go run ./cmd/server
```

```bash
pnpm --filter @share-anywhere/web dev
```

The web dev server runs on <http://localhost:5173> and proxies `/v1`, `/healthz`, and `/readyz` to the backend on port 8080. The brand and token preview is at <http://localhost:5173/brand> in development builds only.

## Android app

Requirements: JDK 17 or newer, the Android SDK with platform 35 and build-tools 35.0.0 (`ANDROID_HOME` set, or `sdk.dir` in an uncommitted `android/local.properties`). The Gradle wrapper downloads and checksum-verifies Gradle 8.14.3.

```bash
cd android && ./gradlew assembleDebug
```

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. It talks to the backend at `http://10.0.2.2:8080`, which is the host machine as the Android emulator sees it, so `docker compose -f docker-compose.ci.yml up -d --build --wait` (plain HTTP on port 8080) is the quickest backend for an emulator. Point a build elsewhere with `-Pbackend=http://<host>:8080`; debug builds allow cleartext only to `10.0.2.2`, `localhost`, and `127.0.0.1` (use `adb reverse tcp:8080 tcp:8080` for a USB device and `-Pbackend=http://localhost:8080`). Release builds need `-PreleaseBackend=https://…` and are signed outside the repository.

```bash
cd android && ./gradlew testDebugUnitTest lintDebug ktlintCheck assembleDebugAndroidTest
```

```bash
cd android && ./gradlew connectedDebugAndroidTest -Pbackend=http://10.0.2.2:8080
```

The last command needs a running emulator or device (CI uses API 34, `.github/workflows/android-emulator.yml`). Theme tokens, string resources, and API models are generated from `shared/` by `pnpm tokens`, `pnpm i18n`, and `pnpm protocol`; never edit `Tokens.kt`, `Api.gen.kt`, or `res/values*/strings.xml` by hand. After changing a dependency, refresh the lockfiles with `./gradlew :app:dependencies buildEnvironment --write-locks`.

## Checks

```bash
pnpm tokens:check && pnpm i18n:check && pnpm protocol:check && pnpm test:scripts && pnpm lint:md
```

```bash
cd backend && go vet ./... && golangci-lint run ./... && go test -race ./...
```

```bash
pnpm --filter @share-anywhere/web format:check && pnpm --filter @share-anywhere/web lint && pnpm --filter @share-anywhere/web typecheck && pnpm --filter @share-anywhere/web test && pnpm --filter @share-anywhere/web build
```

CI runs the same checks plus secret scanning, vulnerability scanning, image builds, and a Compose smoke test (`.github/workflows/ci.yml`).
