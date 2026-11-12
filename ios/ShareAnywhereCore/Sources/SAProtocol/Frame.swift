import Foundation

/// One decoded frame. `file` is `Wire.noFile` when the frame is not about a file.
public struct Frame: Sendable, Equatable {
    public let type: FrameType
    public let flags: UInt16
    public let file: UInt32
    public let block: Int
    public let offset: Int
    public let payload: [UInt8]

    public init(type: FrameType, flags: UInt16 = 0, file: UInt32 = Wire.noFile, block: Int = 0, offset: Int = 0, payload: [UInt8] = []) {
        self.type = type
        self.flags = flags
        self.file = file
        self.block = block
        self.offset = offset
        self.payload = payload
    }

    /// The file index, or -1 when the frame is not about a file.
    public var fileIndex: Int { file == Wire.noFile ? -1 : Int(file) }

    public var isFirst: Bool { flags & Wire.flagFirst != 0 }
    public var isLast: Bool { flags & Wire.flagLast != 0 }

    /// Decodes the JSON body; throws `ProtocolError` for anything malformed.
    public func body<T: Decodable>(_: T.Type) throws -> T {
        guard self.type.carriesJSON else { throw ProtocolError("frame type \(self.type.rawValue) does not carry JSON") }
        guard String(validating: payload, as: UTF8.self) != nil else { throw ProtocolError("invalid JSON payload") }
        do {
            return try JSONDecoder().decode(T.self, from: Data(payload))
        } catch {
            throw ProtocolError("invalid JSON payload")
        }
    }

    /// The frame as bytes on the wire.
    public var encoded: [UInt8] {
        var out = [UInt8]()
        out.reserveCapacity(Wire.headerBytes + payload.count)
        out.append(Wire.version)
        out.append(type.rawValue)
        Frame.put16(&out, flags)
        Frame.put32(&out, file)
        Frame.put32(&out, UInt32(block))
        Frame.put32(&out, UInt32(offset))
        Frame.put32(&out, UInt32(payload.count))
        out.append(contentsOf: payload)
        return out
    }

    public static func encode(
        _ type: FrameType, flags: UInt16 = 0, file: UInt32 = Wire.noFile, block: Int = 0, offset: Int = 0, payload: [UInt8] = []
    ) -> [UInt8] {
        precondition(block >= 0 && block <= Int(Int32.max) && offset >= 0 && offset <= Int(Int32.max), "block or offset out of range")
        return Frame(type: type, flags: flags, file: file, block: block, offset: offset, payload: payload).encoded
    }

    /// A JSON frame (HELLO, FILE_META, NACK, DONE, ERROR).
    public static func json(_ type: FrameType, _ body: some WireBody, file: UInt32 = Wire.noFile, block: Int = 0) throws -> [UInt8] {
        guard type.carriesJSON else { throw ProtocolError("frame type \(type.rawValue) does not carry JSON") }
        return encode(type, file: file, block: block, payload: Array(body.jsonText.utf8))
    }

    /// Decodes one message; throws `ProtocolError` for anything malformed (the caller ends the connection).
    public static func decode(_ bytes: [UInt8]) throws -> Frame {
        guard bytes.count >= Wire.headerBytes else { throw ProtocolError("frame shorter than its header") }
        let version = bytes[0]
        guard version == Wire.version else { throw ProtocolError("unsupported protocol version \(version)") }
        guard let type = FrameType(rawValue: bytes[1]) else { throw ProtocolError("unknown frame type \(bytes[1])") }
        let flags = UInt16(bytes[2]) << 8 | UInt16(bytes[3])
        let file = get32(bytes, 4)
        let block = get32(bytes, 8)
        let offset = get32(bytes, 12)
        let length = get32(bytes, 16)
        guard Int(length) == bytes.count - Wire.headerBytes else { throw ProtocolError("payload length does not match the message") }
        // Same bound as the Web and Android (signed 32-bit there).
        guard block <= UInt32(Int32.max), offset <= UInt32(Int32.max) else { throw ProtocolError("block or offset out of range") }
        if type.isEmpty, length != 0 { throw ProtocolError("control frame with a payload") }
        if type == .block, flags & Wire.flagFirst != 0, Int(length) < Wire.digestBytes {
            throw ProtocolError("first block frame without its digest")
        }
        return Frame(
            type: type,
            flags: flags,
            file: file,
            block: Int(block),
            offset: Int(offset),
            payload: Array(bytes[Wire.headerBytes...])
        )
    }

    private static func put16(_ out: inout [UInt8], _ v: UInt16) {
        out.append(UInt8(v >> 8)); out.append(UInt8(v & 0xFF))
    }

    private static func put32(_ out: inout [UInt8], _ v: UInt32) {
        out.append(UInt8(v >> 24)); out.append(UInt8((v >> 16) & 0xFF)); out.append(UInt8((v >> 8) & 0xFF)); out.append(UInt8(v & 0xFF))
    }

    private static func get32(_ b: [UInt8], _ at: Int) -> UInt32 {
        UInt32(b[at]) << 24 | UInt32(b[at + 1]) << 16 | UInt32(b[at + 2]) << 8 | UInt32(b[at + 3])
    }
}
