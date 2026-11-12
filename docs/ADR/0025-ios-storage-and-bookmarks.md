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

## Amendment (milestone 7.3, as built)

- Received files go to the root of the app's Documents folder, not a `Share Anywhere/` subfolder: Files already shows that folder as On My iPhone › Share Anywhere, so a subfolder would read "Share Anywhere › Share Anywhere".
- A partial download is a hidden file `.sa-<id>.part` in the save folder, and its sidecar is `.sa-<id>.part.json` (the bitmap, file size, block size and the transfer key it belongs to), where `<id>` is a hash of the transfer key. A resume uses the sidecar only when the partial file exists and size and block size match. When the file is verified it is renamed to the sender's file name, made unique in the folder (`name (1).ext`), and the sidecar is deleted. Cancelling, a fatal error, removal or the session ending deletes unfinished partial files with their sidecars. This logic lives in `SATransferRuntime.IncomingFolder` and is tested by `swift test`.
- A picked folder that can no longer be reached (stale bookmark, no write access) returns the receive to the save step with "Couldn't write the file to the chosen folder" instead of silently switching folders, so files never end up somewhere the user did not choose.
- Picked outgoing files are read in place through bookmarks (`fileImporter`, not copies), so a 20 GB file is not duplicated; the bookmarks are kept per session in Application Support (`transfers/outgoing.json`) so the session can serve receivers again after a relaunch.
