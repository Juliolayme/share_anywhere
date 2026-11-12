/// Completed-block bitmap (docs/TRANSFER_PROTOCOL.md §4): bit i is block i, least significant bit first.
/// 20 GB / 4 MiB = 5,120 blocks → 640 bytes. Bits past the last block must be zero.
public struct Bitmap: Sendable, Equatable {
    public let size: Int
    public private(set) var bytes: [UInt8]
    public private(set) var count: Int = 0

    public init(size: Int) {
        precondition(size >= 0, "bitmap size")
        self.size = size
        bytes = [UInt8](repeating: 0, count: (size + 7) / 8)
    }

    /// Restores a bitmap; throws for a wrong length or bits past the last block.
    public init(size: Int, bytes: [UInt8]) throws {
        self.init(size: size)
        guard bytes.count == self.bytes.count else {
            throw ProtocolError("bitmap of \(size) blocks needs \(self.bytes.count) bytes, got \(bytes.count)")
        }
        let rem = size % 8
        if rem != 0, let last = bytes.last, last >> rem != 0 { throw ProtocolError("bits set past the last block") }
        self.bytes = bytes
        count = (0 ..< size).reduce(0) { $0 + (has($1) ? 1 : 0) }
    }

    public func has(_ i: Int) -> Bool { i >= 0 && i < size && (bytes[i >> 3] >> UInt8(i & 7)) & 1 == 1 }

    /// Marks block i; returns true when it was not already set.
    @discardableResult
    public mutating func set(_ i: Int) -> Bool {
        precondition(i >= 0 && i < size, "block \(i) outside 0..\(size - 1)")
        if has(i) { return false }
        bytes[i >> 3] |= 1 << UInt8(i & 7)
        count += 1
        return true
    }

    public var isFull: Bool { count == size }

    /// Missing indices, ascending.
    public func missing() -> [Int] { (0 ..< size).filter { !has($0) } }
}
