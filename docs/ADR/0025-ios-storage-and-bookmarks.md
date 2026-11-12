# ADR 0025: iOS storage and security-scoped bookmarks

Status: Accepted (Phase 7, milestone 7.2, 2026-11-12)

## Context

The phase file leaves local History storage to an ADR (Core Data or GRDB; SwiftData needs iOS 17) and asks for received files in the app's Documents (visible in Files) or in a folder the user picks, remembered as a security-scoped bookmark, with transfer bitmaps as sidecar files. The development session runs on Linux, where Core Data does not exist.

## Decision

- **History in SQLite through a small wrapper in ShareAnywhereCore (`SAStore`)**, not Core Data or GRDB. `Database` binds parameters only (CLAUDE.md §7) and uses Apple's `SQLite3` module on iOS and the system library on Linux. `HistoryStore` is an actor with the same schema and rules as Android's Room repository (entries plus remembered deletions for 7 days, retention sweep, observers), so the store is tested by `swift test` in this environment and on the macOS runner. The database lives in Application Support (`history.sqlite`, WAL), which iOS excludes from Files and includes in device backups like other app data.
- **Settings in `UserDefaults`**; the refresh secret in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, `kSecAttrSynchronizable = false`), never in defaults or files.
- **Received files (milestone 7.3)** go to `Documents/Share Anywhere/` by default (`UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` make it visible in Files) or to a folder picked with `UIDocumentPickerViewController` in folder mode, persisted as a security-scoped bookmark (`bookmarkData(options: [])` is enough on iOS; access is wrapped in `startAccessingSecurityScopedResource`). A stale bookmark falls back to the default folder with a notice.
- **Transfer bitmaps** are sidecar files next to the partial download (`.<name>.sa-bitmap`), so a resume finds them with the file and deleting the file deletes both.

## Alternatives considered

- **Core Data.** Not available on Linux, so the store could only be tested on the macOS runner; the model needs a migration story either way.
- **GRDB.** A mature SQLite library, but a large dependency for two tables, and its Linux support needs extra system configuration.

## Consequences

- Schema changes are explicit migrations keyed by `PRAGMA user_version` in `HistoryStore.migrate`.
