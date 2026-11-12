import Foundation

/// A JSON frame body: written in the Web's key order, read with `JSONDecoder` (unknown keys ignored).
public protocol WireBody: Decodable, Sendable {
    var jsonText: String { get }
}

public struct HelloReceiver: WireBody, Equatable {
    public var v = 1
    public var role = "receiver"
    public var sessionId: String
    public var participantId: String
    public var capability: String

    public init(sessionId: String, participantId: String, capability: String) {
        self.sessionId = sessionId
        self.participantId = participantId
        self.capability = capability
    }

    enum CodingKeys: String, CodingKey { case v, role, sessionId = "session_id", participantId = "participant_id", capability }

    public var jsonText: String {
        var w = JSONObjectWriter()
        w.add("v", v); w.add("role", role); w.add("session_id", sessionId); w.add("participant_id", participantId)
        w.add("capability", capability)
        return w.text
    }
}

public struct HelloSender: WireBody, Equatable {
    public var v = 1
    public var role = "sender"
    public var sessionId: String

    public init(sessionId: String) { self.sessionId = sessionId }

    enum CodingKeys: String, CodingKey { case v, role, sessionId = "session_id" }

    public var jsonText: String {
        var w = JSONObjectWriter()
        w.add("v", v); w.add("role", role); w.add("session_id", sessionId)
        return w.text
    }
}

/// HELLO as read from the peer: the role decides which fields matter.
public struct HelloBody: Decodable, Sendable, Equatable {
    public var v: Int
    public var role: String
    public var sessionId: String?
    public var participantId: String?
    public var capability: String?

    enum CodingKeys: String, CodingKey { case v, role, sessionId = "session_id", participantId = "participant_id", capability }
}

public struct FileMetaEntry: Codable, Sendable, Equatable {
    public var file: Int
    public var fileId: String
    public var transferId: String
    public var name: String
    public var size: Int64
    public var mime: String
    public var blockSize: Int
    public var blockCount: Int

    public init(file: Int, fileId: String, transferId: String, name: String, size: Int64, mime: String, blockSize: Int, blockCount: Int) {
        self.file = file
        self.fileId = fileId
        self.transferId = transferId
        self.name = name
        self.size = size
        self.mime = mime
        self.blockSize = blockSize
        self.blockCount = blockCount
    }

    enum CodingKeys: String, CodingKey {
        case file, fileId = "file_id", transferId = "transfer_id", name, size, mime, blockSize = "block_size", blockCount = "block_count"
    }

    var jsonText: String {
        var w = JSONObjectWriter()
        w.add("file", file); w.add("file_id", fileId); w.add("transfer_id", transferId); w.add("name", name)
        w.add("size", size); w.add("mime", mime); w.add("block_size", blockSize); w.add("block_count", blockCount)
        return w.text
    }
}

public struct FileMeta: WireBody, Equatable {
    public var files: [FileMetaEntry]
    public init(files: [FileMetaEntry]) { self.files = files }

    public var jsonText: String {
        var w = JSONObjectWriter()
        w.addRaw("files", "[" + files.map(\.jsonText).joined(separator: ",") + "]")
        return w.text
    }
}

public struct NackBody: WireBody, Equatable {
    public var reason: String
    public init(reason: String) { self.reason = reason }

    public var jsonText: String {
        var w = JSONObjectWriter()
        w.add("reason", reason)
        return w.text
    }
}

public struct DoneBody: WireBody, Equatable {
    public var sha256: String
    public var ok: Bool?
    public init(sha256: String, ok: Bool? = nil) {
        self.sha256 = sha256
        self.ok = ok
    }

    public var jsonText: String {
        var w = JSONObjectWriter()
        w.add("sha256", sha256); w.add("ok", ok)
        return w.text
    }
}

public struct ErrorBody: WireBody, Equatable {
    public var code: String
    public var fatal: Bool
    public var message: String?
    public init(code: String, fatal: Bool, message: String? = nil) {
        self.code = code
        self.fatal = fatal
        self.message = message
    }

    public var jsonText: String {
        var w = JSONObjectWriter()
        w.add("code", code); w.add("fatal", fatal); w.add("message", message)
        return w.text
    }
}
