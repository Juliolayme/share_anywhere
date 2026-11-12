/// Wire format of the transfer protocol, version 1 (docs/TRANSFER_PROTOCOL.md §2), byte for byte the same as
/// `web/src/features/transfer/engine/frame.ts` and Android's `transfer/engine/Frame.kt`, checked against
/// shared/protocol/schemas/transfer-vectors.json.
///
/// Every DataChannel message is one frame: a 20-byte big-endian header followed by the payload.
///   0 u8 version (1) · 1 u8 type · 2 u16 flags · 4 u32 file · 8 u32 block · 12 u32 offset · 16 u32 payload length
public enum Wire {
    public static let version: UInt8 = 1
    public static let headerBytes = 20
    public static let noFile: UInt32 = 0xFFFF_FFFF
    public static let blockSize = 4 * 1024 * 1024
    public static let frameBytes = 64 * 1024
    public static let digestBytes = 32
    public static let flagFirst: UInt16 = 1
    public static let flagLast: UInt16 = 2

    /// Payload bytes for block data in one frame, given the peer's message limit.
    public static func dataPerFrame(maxMessageSize: Int?) -> Int {
        let peer = (maxMessageSize ?? 0) > 0 ? maxMessageSize! : frameBytes
        return min(frameBytes, peer) - headerBytes
    }

    /// Blocks in a file; an empty file has none.
    public static func blockCount(size: Int64, blockSize: Int = Wire.blockSize) -> Int {
        Int((size + Int64(blockSize) - 1) / Int64(blockSize))
    }

    public static func blockLength(size: Int64, index: Int, blockSize: Int = Wire.blockSize) -> Int {
        Int(min(Int64(blockSize), size - Int64(index) * Int64(blockSize)))
    }
}

public enum FrameType: UInt8, Sendable, CaseIterable {
    case hello = 1, fileMeta = 2, bitmap = 3, block = 4, ack = 5, nack = 6, pause = 7, resume = 8, done = 9, error = 10

    /// Types whose payload is a JSON body.
    public var carriesJSON: Bool { self == .hello || self == .fileMeta || self == .nack || self == .done || self == .error }
    /// Control types that never carry a payload.
    public var isEmpty: Bool { self == .ack || self == .pause || self == .resume }
}

public struct ProtocolError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// ERROR codes (§2). "closed" is local: the channel closed without an ERROR frame.
public enum ErrorCode {
    public static let unauthorized = "unauthorized"
    public static let `protocol` = "protocol"
    public static let storageFull = "storage_full"
    public static let storageError = "storage_error"
    public static let fileUnreadable = "file_unreadable"
    public static let checksumRetries = "checksum_retries"
    public static let fileHashMismatch = "file_hash_mismatch"
    public static let cancelled = "cancelled"
    public static let closed = "closed"
}
