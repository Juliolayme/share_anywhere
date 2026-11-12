import Foundation

/// Why a capture looks sensitive (PRD §7.6, docs/CLIPBOARD_PROTOCOL.md §2.7).
public enum SensitiveKind: String, Sendable, Equatable, Codable {
    case privateKey = "private_key", jwt, otp, card, apiKey = "api_key", token, password
    /// iOS `UIPasteboard.detectPatterns` found a probable secret (or the source app marked the item).
    case flagged
}

/// Best-effort "possibly sensitive" heuristics, the same rules as the Web (sensitive.ts) and Android (`Sensitive`). They
/// run on the device before anything is encrypted or sent. Deliberately conservative: they can miss secrets or flag
/// harmless text, the UI says so, and a manual Sync can override a skip.
public enum Sensitive {
    private static func re(_ p: String) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: p)
    }

    private static let pemPrivate = re("-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----")
    private static let jwt = re("(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])")
    private static let apiKey = re(
        "\\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|" +
            "xox[abposr]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{32,})\\b"
    )
    private static let otp = re("^[0-9]{4,8}$")
    private static let otpSplit = re("^[0-9]{3,4}[ -][0-9]{3,4}$")
    private static let card = re("^(?:[0-9][ -]?){12,18}[0-9]$")
    private static let tokenChars = re("^[A-Za-z0-9+/=_.~-]+$")
    private static let hex = re("^[0-9a-fA-F]+$")

    private static func contains(_ r: NSRegularExpression, _ s: String) -> Bool {
        r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    private static func hasSpace(_ s: String) -> Bool {
        s.unicodeScalars.contains { CharacterSet.whitespacesAndNewlines.contains($0) || $0 == "\u{00A0}" || $0 == "\u{FEFF}" }
    }

    /// Shannon entropy in bits per code point.
    public static func entropy(_ s: String) -> Double {
        let cps = Array(s.unicodeScalars)
        if cps.isEmpty { return 0 }
        var counts: [UnicodeScalar: Int] = [:]
        for c in cps {
            counts[c, default: 0] += 1
        }
        var h = 0.0
        for k in counts.values {
            let p = Double(k) / Double(cps.count)
            h -= p * log2(p)
        }
        return h
    }

    private static func luhn(_ digits: String) -> Bool {
        var sum = 0
        var double = false
        for ch in digits.reversed() {
            guard var d = ch.wholeNumberValue else { return false }
            if double {
                d *= 2
                if d > 9 { d -= 9 }
            }
            sum += d
            double.toggle()
        }
        return sum % 10 == 0
    }

    private static func classes(_ s: String) -> Int {
        let u = s.unicodeScalars
        let lower = u.contains { ("a" ... "z").contains($0) }
        let upper = u.contains { ("A" ... "Z").contains($0) }
        let digit = u.contains { ("0" ... "9").contains($0) }
        let other = u.contains { !(("a" ... "z").contains($0) || ("A" ... "Z").contains($0) || ("0" ... "9").contains($0)) }
        return [lower, upper, digit, other].filter { $0 }.count
    }

    /// Why `text` looks sensitive, or nil (checked in the Web's order).
    public static func kind(_ text: String) -> SensitiveKind? {
        if contains(pemPrivate, text) { return .privateKey }
        if contains(jwt, text) { return .jwt }
        if contains(apiKey, text) { return .apiKey }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if contains(otp, t) || contains(otpSplit, t) { return .otp }
        if contains(card, t) {
            let digits = t.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
            if (13 ... 19).contains(digits.count), luhn(digits) { return .card }
        }
        if hasSpace(t) || t.contains("://") { return nil }
        let len = t.unicodeScalars.count
        if (24 ... 512).contains(len), contains(tokenChars, t) {
            let isHex = contains(hex, t)
            if (isHex && len >= 32 && entropy(t) >= 3) || (!isHex && classes(t) >= 3 && entropy(t) >= 4) { return .token }
        }
        if (8 ... 64).contains(len), classes(t) == 4 { return .password }
        return nil
    }
}
