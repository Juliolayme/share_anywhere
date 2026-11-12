import Foundation
import SAStore
import SwiftUI

/// User settings in UserDefaults (ST-1). Values match the Web's and Android's where they are shared.
@MainActor
final class SettingsStore: ObservableObject {
    enum Theme: String, CaseIterable { case system, light, dark }
    enum Language: String, CaseIterable { case system, en, vi }

    private let defaults: UserDefaults

    @Published var welcomed: Bool { didSet { defaults.set(welcomed, forKey: "welcomed") } }
    @Published var theme: Theme { didSet { defaults.set(theme.rawValue, forKey: "theme") } }
    @Published var language: Language {
        didSet {
            defaults.set(language.rawValue, forKey: "language")
            L10n.override = language == .system ? nil : language.rawValue
        }
    }

    /// Keep screen on during transfers (default on; docs/ARCHITECTURE.md §7).
    @Published var keepScreenOn: Bool { didSet { defaults.set(keepScreenOn, forKey: "keepScreenOn") } }
    @Published var retention: Retention { didSet { defaults.set(retention.rawValue, forKey: "historyRetention") } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        welcomed = defaults.bool(forKey: "welcomed")
        theme = Theme(rawValue: defaults.string(forKey: "theme") ?? "") ?? .system
        let lang = Language(rawValue: defaults.string(forKey: "language") ?? "") ?? .system
        language = lang
        keepScreenOn = defaults.object(forKey: "keepScreenOn") as? Bool ?? true
        retention = Retention.fromStored(defaults.string(forKey: "historyRetention"))
        L10n.override = lang == .system ? nil : lang.rawValue
    }

    var colorScheme: ColorScheme? {
        switch theme {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
