import Foundation

/// Strings from Localizable.xcstrings (generated from shared/i18n by scripts/gen-i18n.mjs; keys "ns.key"). The
/// language follows the system unless Settings picks English or Vietnamese. `{name}` placeholders are filled here, as
/// on Android, so no catalog value is a printf format.
enum L10n {
    /// "en", "vi", or nil for the system language.
    nonisolated(unsafe) static var override: String? {
        didSet { bundle = L10n.bundle(for: override) }
    }

    private nonisolated(unsafe) static var bundle: Bundle = L10n.bundle(for: nil)

    private static func bundle(for language: String?) -> Bundle {
        guard let language, let path = Bundle.main.path(forResource: language, ofType: "lproj"), let b = Bundle(path: path) else {
            return .main
        }
        return b
    }

    /// The language strings are shown in now ("en" or "vi").
    static var current: String {
        if let override { return override }
        let preferred = Bundle.main.preferredLocalizations.first ?? "en"
        return preferred.hasPrefix("vi") ? "vi" : "en"
    }

    static func t(_ key: String, _ args: [String: String] = [:]) -> String {
        let raw = bundle.localizedString(forKey: key, value: nil, table: "Localizable")
        return fill(raw, args)
    }

    /// Replaces each `{name}` with its argument; unknown placeholders stay as they are.
    static func fill(_ template: String, _ args: [String: String]) -> String {
        guard !args.isEmpty else { return template }
        var out = template
        for (k, v) in args {
            out = out.replacingOccurrences(of: "{\(k)}", with: v)
        }
        return out
    }
}
