import Foundation
import SATransferRuntime
import UniformTypeIdentifiers

/// A file picked for sending (TR-2): read through a security-scoped bookmark so the session can serve receivers again
/// after a relaunch (docs/ADR/0025-ios-storage-and-bookmarks.md).
struct PickedFile: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let size: Int64
    let mime: String
    let bookmark: Data

    /// Reads name, size and type and makes a bookmark; nil when the file cannot be read.
    static func from(_ url: URL) -> PickedFile? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey, .contentTypeKey]),
              values.isDirectory != true, let size = values.fileSize,
              let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else { return nil }
        let mime = values.contentType?.preferredMIMEType ?? UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        return PickedFile(name: url.lastPathComponent, size: Int64(size), mime: mime ?? "application/octet-stream", bookmark: bookmark)
    }
}

/// An outgoing file opened from its bookmark, with security-scoped access held until the session ends.
final class ScopedFileSource: ClosableFileSource, @unchecked Sendable {
    let size: Int64
    private let inner: FileReadSource
    private let url: URL
    private let scoped: Bool

    init?(_ file: OutgoingFile) {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: file.locator, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            return nil
        }
        let scoped = url.startAccessingSecurityScopedResource()
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map { Int64($0) }
        guard size == file.size else {
            if scoped { url.stopAccessingSecurityScopedResource() }
            return nil
        }
        self.url = url
        self.scoped = scoped
        self.size = file.size
        inner = FileReadSource(url: url, size: file.size)
    }

    func read(offset: Int64, length: Int) async throws -> [UInt8] { try await inner.read(offset: offset, length: length) }

    func close() {
        inner.close()
        if scoped { url.stopAccessingSecurityScopedResource() }
    }
}

enum SaveFolders {
    /// The app's Documents folder: Files shows it as On My iPhone › Share Anywhere (UIFileSharingEnabled).
    static var documents: URL {
        (try? FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
    }

    static func documentsTarget() -> SaveTarget { SaveTarget(kind: .documents, label: L10n.t("product.rx_documents_h")) }

    /// A picked folder as a target (bookmark kept for later sessions and relaunches).
    static func folderTarget(_ url: URL) -> SaveTarget? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else { return nil }
        return SaveTarget(kind: .folder, bookmark: bookmark, label: url.lastPathComponent)
    }

    /// Resolves a target and holds access to it until `release`; nil when it can no longer be reached.
    static func resolve(_ target: SaveTarget) -> ScopedFolder? {
        switch target.kind {
        case .documents:
            return ScopedFolder(url: documents)
        case .folder:
            var stale = false
            guard let data = target.bookmark,
                  let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
            else { return nil }
            let scoped = url.startAccessingSecurityScopedResource()
            guard FileManager.default.isWritableFile(atPath: url.path) else {
                if scoped { url.stopAccessingSecurityScopedResource() }
                return nil
            }
            return ScopedFolder(url: url) { if scoped { url.stopAccessingSecurityScopedResource() } }
        }
    }

    /// A Files app link to a saved file (opens the containing folder in Files).
    static func filesLink(_ url: URL) -> URL? {
        URL(string: "shareddocuments://" + (url.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? url.path))
    }
}
