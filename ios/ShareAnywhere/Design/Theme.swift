import SwiftUI

/// The token palette for the current colour scheme (docs/DESIGN_SYSTEM.md), read from the environment.
struct PaletteKey: EnvironmentKey {
    static let defaultValue = SATokens.light
}

extension EnvironmentValues {
    var palette: SAPalette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// Applies the palette that matches the effective colour scheme.
struct Themed: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .environment(\.palette, scheme == .dark ? SATokens.dark : SATokens.light)
            .tint(scheme == .dark ? SATokens.dark.send : SATokens.light.send)
    }
}

extension View {
    func themed() -> some View { modifier(Themed()) }

    /// The design screen ID (docs/UX_SCREEN_MAP.md §12) on a container that keeps its children accessible, so tests
    /// find both the screen and the controls in it.
    func screenID(_ id: String) -> some View { accessibilityElement(children: .contain).accessibilityIdentifier(id) }

    /// A type step from the tokens, scaled with Dynamic Type.
    func typeStyle(_ s: SATypeStyle) -> some View { modifier(TypeStyleModifier(style: s)) }
}

struct TypeStyleModifier: ViewModifier {
    let style: SATypeStyle
    @ScaledMetric private var scale: CGFloat = 1
    func body(content: Content) -> some View {
        content
            .font(.system(size: style.size * scale, weight: style.weight, design: style.mono ? .monospaced : .default))
            .lineSpacing(max(0, style.line - style.size) * scale / 2)
    }
}
