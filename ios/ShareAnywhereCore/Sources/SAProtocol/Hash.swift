import Crypto
import Foundation

public extension Sequence<UInt8> {
    var hex: String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        for b in self {
            out.append(digits[Int(b >> 4)]); out.append(digits[Int(b & 0x0F)])
        }
        return String(decoding: out, as: UTF8.self)
    }
}

public func sha256(_ data: some DataProtocol) -> [UInt8] { Array(SHA256.hash(data: data)) }

/// Constant-time comparison (digests).
public func equalBytes(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    guard a.count == b.count else { return false }
    var diff: UInt8 = 0
    for i in 0 ..< a.count {
        diff |= a[i] ^ b[i]
    }
    return diff == 0
}

/// Whole-file SHA-256 fed strictly in order; ignores bytes already hashed and refuses gaps.
public struct StreamHasher {
    private var hasher = SHA256()
    public private(set) var position: Int64 = 0

    public init() {}

    /// Feeds `data` found at `offset`; returns false (and hashes nothing) when it would leave a gap.
    @discardableResult
    public mutating func update(offset: Int64, _ data: some RandomAccessCollection<UInt8>) -> Bool {
        if offset > position { return false }
        let skip = position - offset
        if skip >= Int64(data.count) { return true }
        let rest = data.dropFirst(Int(skip))
        rest.withContiguousStorageIfAvailable { hasher.update(bufferPointer: UnsafeRawBufferPointer($0)) } ?? hasher
            .update(data: Array(rest))
        position += Int64(rest.count)
        return true
    }

    public func hex() -> String { hasher.finalize().hex }
}
