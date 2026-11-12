import SwiftUI

/// Filled primary action (Button lg/md in docs/DESIGN_SYSTEM.md §6), at least 44 pt tall.
struct PrimaryButton: View {
    enum Tone { case send, receive, danger }
    let title: String
    var tone: Tone = .send
    var enabled = true
    let action: () -> Void
    @Environment(\.palette) private var p

    var body: some View {
        Button(action: action) {
            Text(title)
                .typeStyle(SATokens.TypeScale.labelLg)
                .frame(maxWidth: .infinity, minHeight: SATokens.Control.lg)
                .foregroundStyle(fg)
                .background(bg.opacity(enabled ? 1 : 0.45), in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private var bg: Color {
        switch tone {
        case .send: p.send
        case .receive: p.receive
        case .danger: p.danger
        }
    }

    private var fg: Color {
        switch tone {
        case .send: p.onSend
        case .receive: p.onReceive
        case .danger: .white
        }
    }
}

/// Outlined secondary action.
struct SecondaryButton: View {
    let title: String
    var enabled = true
    let action: () -> Void
    @Environment(\.palette) private var p

    var body: some View {
        Button(action: action) {
            Text(title)
                .typeStyle(SATokens.TypeScale.labelLg)
                .frame(maxWidth: .infinity, minHeight: SATokens.Control.md)
                .foregroundStyle(p.sendInk)
                .overlay(RoundedRectangle(cornerRadius: SATokens.Radius.md).stroke(p.borderStrong, lineWidth: SATokens.Border.thin))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

/// A grouped surface with the token radius and border.
struct Card<Content: View>: View {
    @ViewBuilder let content: Content
    @Environment(\.palette) private var p

    var body: some View {
        VStack(alignment: .leading, spacing: SATokens.Space.s3) { content }
            .padding(SATokens.Space.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: SATokens.Radius.lg).stroke(p.border, lineWidth: SATokens.Border.thin))
    }
}

/// Inline notice (Permission/offline banner).
struct Banner: View {
    enum Kind { case info, warning, danger }
    let kind: Kind
    let title: String
    var message: String?
    var actionTitle: String?
    var action: (() -> Void)?
    @Environment(\.palette) private var p

    var body: some View {
        HStack(alignment: .top, spacing: SATokens.Space.s3) {
            Image(systemName: icon).foregroundStyle(ink).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: SATokens.Space.s1) {
                Text(title).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(ink)
                if let message { Text(message).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2) }
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .typeStyle(SATokens.TypeScale.labelLg)
                        .frame(minHeight: SATokens.touchTarget)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(SATokens.Space.s4)
        .background(soft, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch kind {
        case .info: "info.circle"
        case .warning: "exclamationmark.triangle"
        case .danger: "xmark.octagon"
        }
    }

    private var ink: Color {
        switch kind {
        case .info: p.sendInk
        case .warning: p.warningInk
        case .danger: p.dangerInk
        }
    }

    private var soft: Color {
        switch kind {
        case .info: p.sendSoft
        case .warning: p.warningSoft
        case .danger: p.dangerSoft
        }
    }
}

/// Small status label (Status chip / badge). Status chips pass a token pair (`*-ink` text on `*-soft`), which the
/// token contrast check holds to WCAG AA; a colour without a background gets a light tint of itself.
struct Chip: View {
    let text: String
    var color: Color?
    var background: Color?
    @Environment(\.palette) private var p

    var body: some View {
        Text(text)
            .typeStyle(SATokens.TypeScale.caption)
            .padding(.horizontal, SATokens.Space.s2)
            .padding(.vertical, SATokens.Space.s1)
            .foregroundStyle(color ?? p.fg2)
            .background(background ?? (color ?? p.fg2).opacity(0.12), in: Capsule())
    }
}

/// Empty state: icon, heading, body.
struct EmptyState: View {
    let icon: String
    let title: String
    let message: String
    @Environment(\.palette) private var p

    var body: some View {
        VStack(spacing: SATokens.Space.s3) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(p.fg3).accessibilityHidden(true)
            Text(title).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg).multilineTextAlignment(.center)
            Text(message).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2).multilineTextAlignment(.center)
        }
        .padding(SATokens.Space.s8)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// The logo symbol from the token geometry (48-unit viewBox), with an optional wordmark.
struct LogoMark: View {
    var size: CGFloat = 40
    var wordmark = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = scheme == .dark ? SATokens.Logo.forDark : SATokens.Logo.forLight
        HStack(spacing: size * SATokens.Logo.wordmarkGapRatio) {
            Canvas { ctx, sz in
                let k = sz.width / SATokens.Logo.viewBox
                func capsule(_ g: [CGFloat], _ color: Color) {
                    let r = CGRect(x: g[0] * k, y: g[1] * k, width: g[2] * k, height: g[3] * k)
                    ctx.fill(Path(roundedRect: r, cornerRadius: g[4] * k), with: .color(color))
                }
                func dot(_ g: [CGFloat]) {
                    let r = CGRect(x: (g[0] - g[2]) * k, y: (g[1] - g[2]) * k, width: 2 * g[2] * k, height: 2 * g[2] * k)
                    ctx.fill(Path(ellipseIn: r), with: .color(c.dot))
                }
                capsule(SATokens.Logo.capsuleSend, c.send)
                capsule(SATokens.Logo.capsuleReceive, c.receive)
                dot(SATokens.Logo.dotSend)
                dot(SATokens.Logo.dotReceive)
            }
            .frame(width: size, height: size)
            if wordmark {
                Text("Share Anywhere")
                    .font(SAFont.font(size: size * SATokens.Logo.wordmarkSizeRatio, weight: .bold))
                    .foregroundStyle(c.text)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Share Anywhere")
    }
}

/// Byte counts as the design shows them ("1.2 GB").
func formatBytes(_ n: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: n, countStyle: .file)
}
