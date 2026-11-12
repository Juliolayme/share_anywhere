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
    @ScaledMetric private var scale: CGFloat

    init(style: SATypeStyle) {
        self.style = style
        _scale = ScaledMetric(wrappedValue: 1, relativeTo: style.textStyle)
    }

    func body(content: Content) -> some View {
        content
            .font(style.font)
            .lineSpacing(max(0, style.line - style.size) * scale / 2)
    }
}

extension SATypeStyle {
    /// The Dynamic Type text style this step scales with: the one whose default size (Large) equals the step, or the
    /// nearest smaller one.
    var textStyle: Font.TextStyle { SAFont.textStyle(for: size) }

    /// The token step as a Dynamic Type font: a system text style when its default size is the step's size (every
    /// step but the 40 pt display), otherwise the system font at the step's size scaled relative to the nearest
    /// text style. Fixed `.system(size:)` fonts do not follow the user's text size (accessibility audit).
    var font: Font { SAFont.font(size: size, weight: weight, mono: mono) }
}

enum SAFont {
    /// Default (Large) point sizes of the text styles (Apple Human Interface Guidelines, iOS).
    private static let defaults: [(Font.TextStyle, CGFloat)] = [
        (.largeTitle, 34), (.title, 28), (.title2, 22), (.title3, 20), (.body, 17), (.callout, 16),
        (.subheadline, 15), (.footnote, 13), (.caption, 12), (.caption2, 11)
    ]

    static func textStyle(for size: CGFloat) -> Font.TextStyle {
        defaults.first { size >= $0.1 }?.0 ?? .caption2
    }

    static func font(size: CGFloat, weight: Font.Weight, mono: Bool = false) -> Font {
        let style = textStyle(for: size)
        let design: Font.Design = mono ? .monospaced : .default
        if defaults.contains(where: { $0.0 == style && $0.1 == size }) {
            return .system(style, design: design, weight: weight)
        }
        // No text style has this default size: the system font (a name no font has resolves to it) at the step's
        // size, scaled with the nearest text style.
        let custom = Font.custom("SAFontSystem", size: size, relativeTo: style).weight(weight)
        return mono ? custom.monospaced() : custom
    }
}
