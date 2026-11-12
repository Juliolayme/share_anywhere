import Crypto
import Foundation

/// A small dictionary persisted as one JSON file (atomic writes), for the per-session records the runtime keeps:
/// save targets, outgoing file locators, and where finished downloads went. Not for bulk data.
public actor JSONMap<Value: Codable & Sendable> {
    private let url: URL
    private var cache: [String: Value]?

    public init(url: URL) { self.url = url }

    private func load() -> [String: Value] {
        if let cache { return cache }
        let read = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode([String: Value].self, from: $0) } ?? [:]
        cache = read
        return read
    }

    public func get(_ key: String) -> Value? { load()[key] }

    public func all() -> [String: Value] { load() }

    public func put(_ key: String, _ value: Value?) throws {
        var map = load()
        map[key] = value
        cache = map
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(map).write(to: url, options: .atomic)
    }
}

/// Where a receive saves: the app's Documents folder (visible in Files as On My iPhone › Share Anywhere) or a folder
/// the user picked, kept as a security-scoped bookmark (docs/ADR/0025-ios-storage-and-bookmarks.md).
public struct SaveTarget: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case documents, folder }
    public var kind: Kind
    /// Bookmark data for `folder` (resolved by the app); nil for `documents`.
    public var bookmark: Data?
    /// The folder's name for display.
    public var label: String

    public init(kind: Kind, bookmark: Data? = nil, label: String) {
        self.kind = kind
        self.bookmark = bookmark
        self.label = label
    }
}

/// A picked outgoing file: its server id and size, and an opaque locator (a security-scoped bookmark in the app, a
/// path in tests) so the session can serve receivers again after a relaunch.
public struct OutgoingFile: Codable, Sendable, Equatable {
    public var fileId: String
    public var size: Int64
    public var locator: Data

    public init(fileId: String, size: Int64, locator: Data) {
        self.fileId = fileId
        self.size = size
        self.locator = locator
    }
}

/// Progress of one incoming file, written as a sidecar next to the partial download (docs/TRANSFER_PROTOCOL.md §4):
/// the bitmap of verified blocks and what it belongs to, so a resume never trusts a bitmap for another file.
public struct Sidecar: Codable, Sendable, Equatable {
    public var key: String
    public var name: String
    public var size: Int64
    public var blockSize: Int
    public var bitmap: Data
    public var updatedAt: Int64
}

/// A file read in slices for sending; the handle opens on first use.
public final class FileReadSource: FileSource, @unchecked Sendable {
    public let size: Int64
    private let url: URL
    private let lock = NSLock()
    private var handle: FileHandle?
    private var closed = false

    public init(url: URL, size: Int64) {
        self.url = url
        self.size = size
    }

    public func read(offset: Int64, length: Int) async throws -> [UInt8] {
        try lock.locked {
            if closed { throw TransferIOError("closed") }
            do {
                if handle == nil { handle = try FileHandle(forReadingFrom: url) }
                try handle!.seek(toOffset: UInt64(offset))
                return try [UInt8](handle!.read(upToCount: length) ?? Data())
            } catch {
                throw TransferIOError("The file can no longer be read.")
            }
        }
    }

    public func close() {
        lock.locked {
            closed = true
            try? handle?.close()
            handle = nil
        }
    }
}

/// Writes one partial download at block offsets; `flush` syncs before a block is acknowledged.
public final class PartialFileSink: Sink, @unchecked Sendable {
    private let url: URL
    private let lock = NSLock()
    private var handle: FileHandle?

    public init(url: URL) { self.url = url }

    private func open() throws -> FileHandle {
        if let handle { return handle }
        let h = try FileHandle(forUpdating: url)
        handle = h
        return h
    }

    public func write(offset: Int64, _ data: [UInt8]) async throws {
        try lock.locked {
            do {
                let h = try open()
                try h.seek(toOffset: UInt64(offset))
                try h.write(contentsOf: Data(data))
            } catch {
                throw PartialFileSink.map(error)
            }
        }
    }

    public func read(offset: Int64, length: Int) async throws -> [UInt8] {
        try lock.locked {
            do {
                let h = try open()
                try h.seek(toOffset: UInt64(offset))
                return try [UInt8](h.read(upToCount: length) ?? Data())
            } catch {
                throw TransferIOError("read failed")
            }
        }
    }

    public func flush() async throws {
        try lock.locked {
            do { try handle?.synchronize() } catch { throw PartialFileSink.map(error) }
        }
    }

    public func close() {
        lock.locked {
            try? handle?.close()
            handle = nil
        }
    }

    static func map(_ error: any Error) -> any Error {
        let e = error as NSError
        let full = (e.domain == NSPOSIXErrorDomain && e.code == Int(ENOSPC)) ||
            (e.domain == NSCocoaErrorDomain && e.code == NSFileWriteOutOfSpaceError)
        if full { return StorageFullError("The device is out of space.") }
        if let underlying = e.userInfo[NSUnderlyingErrorKey] as? NSError,
           underlying.domain == NSPOSIXErrorDomain, underlying.code == Int(ENOSPC) {
            return StorageFullError("The device is out of space.")
        }
        return TransferIOError("write failed")
    }
}

/// The partial downloads and sidecars of one save folder. Partial files are hidden (`.sa-<id>.part`) until verified,
/// then renamed to the sender's file name, made unique in the folder.
public struct IncomingFolder: Sendable {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    static func id(_ key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    public func partialURL(_ key: String) -> URL { directory.appendingPathComponent(".sa-\(IncomingFolder.id(key)).part") }

    func sidecarURL(_ key: String) -> URL { directory.appendingPathComponent(".sa-\(IncomingFolder.id(key)).part.json") }

    /// The saved progress of `key`, only while its partial file still exists and matches the size and block size.
    public func load(_ key: String, size: Int64, blockSize: Int) -> Sidecar? {
        guard FileManager.default.fileExists(atPath: partialURL(key).path),
              let data = try? Data(contentsOf: sidecarURL(key)),
              let s = try? JSONDecoder().decode(Sidecar.self, from: data),
              s.key == key, s.size == size, s.blockSize == blockSize else { return nil }
        return s
    }

    /// Any saved progress of `key` (for showing resumed bytes before the sender describes the files).
    public func peek(_ key: String) -> Sidecar? {
        guard FileManager.default.fileExists(atPath: partialURL(key).path),
              let data = try? Data(contentsOf: sidecarURL(key)),
              let s = try? JSONDecoder().decode(Sidecar.self, from: data), s.key == key else { return nil }
        return s
    }

    /// Starts a new partial file (replacing any stale one) and its sidecar.
    public func create(_ key: String, name: String, size: Int64, blockSize: Int, blockCount: Int, now: Int64) throws -> Sidecar {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let part = partialURL(key)
        try? FileManager.default.removeItem(at: part)
        guard FileManager.default.createFile(atPath: part.path, contents: nil) else {
            throw TransferIOError("The file could not be created in the chosen folder.")
        }
        let s = Sidecar(
            key: key,
            name: name,
            size: size,
            blockSize: blockSize,
            bitmap: Data(Bitmap(size: blockCount).bytes),
            updatedAt: now
        )
        try save(s)
        return s
    }

    public func save(_ s: Sidecar) throws {
        do {
            try JSONEncoder().encode(s).write(to: sidecarURL(s.key), options: .atomic)
        } catch {
            throw PartialFileSink.map(error)
        }
    }

    /// Moves a verified partial file to its final unique name and drops the sidecar; returns the final URL.
    public func finish(_ key: String, name: String) throws -> URL {
        let target = uniqueURL(for: name)
        try FileManager.default.moveItem(at: partialURL(key), to: target)
        try? FileManager.default.removeItem(at: sidecarURL(key))
        return target
    }

    /// Removes an unfinished partial file and its sidecar (a bitmap without its file would resume into a mismatch).
    public func discard(_ key: String) {
        try? FileManager.default.removeItem(at: partialURL(key))
        try? FileManager.default.removeItem(at: sidecarURL(key))
    }

    func uniqueURL(for name: String) -> URL {
        let clean = IncomingFolder.safeName(name)
        let ext = (clean as NSString).pathExtension
        let stem = (clean as NSString).deletingPathExtension
        var candidate = directory.appendingPathComponent(clean)
        var n = 1
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = directory.appendingPathComponent(ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)")
            n += 1
        }
        return candidate
    }

    /// A file name that stays inside the folder: no path separators or control characters, no leading dots.
    public static func safeName(_ name: String) -> String {
        var s = String(name.unicodeScalars.map { c -> Character in
            if c == "/" || c == "\\" || c == ":" || c.value < 0x20 || c.value == 0x7F { return "_" }
            return Character(c)
        })
        while s.hasPrefix(".") {
            s.removeFirst()
        }
        s = s.trimmingCharacters(in: .whitespaces)
        if s.count > 200 {
            let ext = (s as NSString).pathExtension
            let keep = 200 - (ext.isEmpty ? 0 : ext.count + 1)
            s = String(s.prefix(keep)) + (ext.isEmpty ? "" : "." + ext)
        }
        return s.isEmpty ? "file" : s
    }
}

/// Hex SHA-256 of UTF-8 text (capability hashes, transfer keys).
public func sha256Hex(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}
