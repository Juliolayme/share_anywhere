import Foundation

/// Compact JSON text with keys in a given order and nulls omitted: the output of the Web's `JSON.stringify` for the
/// protocol bodies (docs/TRANSFER_PROTOCOL.md §2 requires byte-identical frames). Foundation's `JSONEncoder` does
/// not promise key order, so bodies are written with this builder and read with `JSONDecoder`.
public struct JSONObjectWriter {
    private var parts: [String] = []

    public init() {}

    public mutating func add(_ key: String, _ value: String?) {
        if let value { parts.append("\(JSONObjectWriter.quote(key)):\(JSONObjectWriter.quote(value))") }
    }

    public mutating func add(_ key: String, _ value: Int64?) {
        if let value { parts.append("\(JSONObjectWriter.quote(key)):\(value)") }
    }

    public mutating func add(_ key: String, _ value: Int?) { add(key, value.map(Int64.init)) }

    public mutating func add(_ key: String, _ value: Bool?) {
        if let value { parts.append("\(JSONObjectWriter.quote(key)):\(value ? "true" : "false")") }
    }

    /// A value that is already JSON text (a nested object or array).
    public mutating func addRaw(_ key: String, _ json: String) {
        parts.append("\(JSONObjectWriter.quote(key)):\(json)")
    }

    public var text: String { "{" + parts.joined(separator: ",") + "}" }

    /// String escaping as `JSON.stringify`: quote, backslash and control characters only.
    public static func quote(_ s: String) -> String {
        var out = "\""
        out.reserveCapacity(s.utf8.count + 2)
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}
