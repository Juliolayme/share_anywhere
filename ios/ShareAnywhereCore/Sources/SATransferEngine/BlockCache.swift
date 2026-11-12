/// A block read from the file with its SHA-256, shared by every receiver's connection.
public struct CachedBlock: Sendable {
    public let data: [UInt8]
    public let sum: [UInt8]
}

/// Sender-side block cache shared by the connections to all receivers of a session (docs/TRANSFER_PROTOCOL.md §5.1):
/// least recently used blocks are evicted beyond `maxBytes`, and concurrent requests for the same block share one read
/// and one hash.
public actor BlockCache {
    /// 64 MiB, as on the Web and Android; never less than one block.
    public static let defaultBytes = 64 * 1024 * 1024

    public let maxBytes: Int
    private var entries: [UInt64: CachedBlock] = [:]
    private var order: [UInt64] = []
    private var pending: [UInt64: Task<CachedBlock, any Error>] = [:]
    public private(set) var bytes = 0
    public private(set) var reads = 0
    public private(set) var hits = 0
    public private(set) var evictions = 0

    public init(maxBytes: Int = BlockCache.defaultBytes) { self.maxBytes = maxBytes }

    public func get(file: Int, block: Int, load: @escaping @Sendable () async throws -> [UInt8]) async throws -> CachedBlock {
        let key = UInt64(UInt32(truncatingIfNeeded: file)) << 32 | UInt64(UInt32(truncatingIfNeeded: block))
        if let e = entries[key] {
            hits += 1
            touch(key)
            return e
        }
        if let p = pending[key] {
            hits += 1
            return try await p.value
        }
        reads += 1
        let task = Task { () async throws -> CachedBlock in
            let data = try await load()
            return CachedBlock(data: data, sum: sha256(data))
        }
        pending[key] = task
        defer { pending[key] = nil }
        let entry = try await task.value
        insert(key, entry)
        return entry
    }

    public func clear() {
        entries.removeAll()
        order.removeAll()
        bytes = 0
    }

    private func touch(_ key: UInt64) {
        if let i = order.firstIndex(of: key) { order.remove(at: i) }
        order.append(key)
    }

    private func insert(_ key: UInt64, _ entry: CachedBlock) {
        let size = entry.data.count
        if size > maxBytes { return }
        if entries[key] == nil { bytes += size }
        entries[key] = entry
        touch(key)
        while bytes > maxBytes, !order.isEmpty {
            let k = order.removeFirst()
            if let e = entries.removeValue(forKey: k) {
                bytes -= e.data.count
                evictions += 1
            }
        }
    }
}
