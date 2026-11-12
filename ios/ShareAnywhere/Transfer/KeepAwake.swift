import SwiftUI
import UIKit

/// Keep screen on (docs/ARCHITECTURE.md §7, PRD §5.10): `isIdleTimerDisabled` is true only while something is sending,
/// receiving or waiting for receivers, the setting is on, and the scene is active. Screens and the transfer hub add and
/// remove reasons; pausing, finishing, cancelling, removal, a session ending, the setting going off and the app
/// leaving the screen all turn it off, and it comes back when the app is active again.
@MainActor
final class KeepAwake: ObservableObject {
    @Published private(set) var reasons: Set<String> = []
    /// Sessions whose screen-on the user turned off with the pill ("off for this transfer").
    @Published private(set) var userOff: Set<String> = []
    /// The value last applied to `UIApplication.shared.isIdleTimerDisabled`.
    @Published private(set) var screenOn = false
    @Published private(set) var enabled = true
    private var sceneActive = true
    /// Turns the setting back on from the pill ("Screen-on is off in Settings").
    var enableSetting: () -> Void = {}

    /// Whether a session has an active reason (bytes moving or waiting) right now.
    func wanted(_ context: String) -> Bool { reasons.contains { $0.hasSuffix(context) } }

    func setUserOff(_ context: String, _ off: Bool) {
        if off { userOff.insert(context) } else { userOff.remove(context) }
        apply()
    }

    func set(_ reason: String, _ on: Bool) {
        if on, !reasons.contains(reason) {
            reasons.insert(reason)
        } else if !on, reasons.contains(reason) {
            reasons.remove(reason)
        } else {
            return
        }
        apply()
    }

    func setEnabled(_ on: Bool) {
        enabled = on
        apply()
    }

    /// `isIdleTimerDisabled` right after the app last left the screen (the `-uiTesting` probe shows it; nil before).
    @Published private(set) var onBackground: Bool?

    func setSceneActive(_ active: Bool) {
        sceneActive = active
        apply()
        if !active { onBackground = UIApplication.shared.isIdleTimerDisabled }
    }

    private func apply() {
        let effective = reasons.filter { r in !userOff.contains { r.hasSuffix($0) } }
        let want = enabled && sceneActive && !effective.isEmpty
        if UIApplication.shared.isIdleTimerDisabled != want { UIApplication.shared.isIdleTimerDisabled = want }
        if screenOn != want { screenOn = want }
    }
}

/// Keep-open banner with the screen-on pill (docs/ARCHITECTURE.md §7), shown on every screen that sends, receives or
/// waits for a peer. `paused` shows "Screen can sleep — paused" while this screen's transfer is paused.
struct KeepOpenBanner: View {
    var paused = false
    /// The session the pill toggles for ("off for this transfer").
    let context: String
    @EnvironmentObject private var keepAwake: KeepAwake
    @Environment(\.palette) private var p

    var body: some View {
        VStack(alignment: .leading, spacing: SATokens.Space.s2) {
            HStack(alignment: .top, spacing: SATokens.Space.s3) {
                Image(systemName: "iphone").foregroundStyle(p.warningInk).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: SATokens.Space.s1) {
                    Text(L10n.t("ios.keep")).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
                    Text(L10n.t("product.hint_ios_lock")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                        .accessibilityIdentifier("keepopen.lock-hint")
                }
            }
            ScreenOnPill(paused: paused, context: context)
        }
        .padding(SATokens.Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p.warningSoft, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("keep-open-banner")
    }
}

/// The screen-on pill (docs/ARCHITECTURE.md §7.3): "Screen stays on" (tap: off for this transfer), "Screen can sleep"
/// after that (tap: on again), "Screen can sleep — paused" while nothing moves, and "Screen-on is off in Settings"
/// (tap: turn the setting on).
struct ScreenOnPill: View {
    var paused = false
    let context: String
    @EnvironmentObject private var keepAwake: KeepAwake
    @Environment(\.palette) private var p

    private enum Mode { case setOff, on, userOff, paused }

    private var mode: Mode {
        if !keepAwake.enabled { return .setOff }
        // Nothing moving or waiting (paused, finished, cancelled): the screen may sleep whatever the pill said.
        if paused || !keepAwake.wanted(context) { return .paused }
        if keepAwake.userOff.contains(context) { return .userOff }
        return keepAwake.screenOn ? .on : .paused
    }

    var body: some View {
        let m = mode
        let (text, icon): (String, String) = switch m {
        case .setOff: (L10n.t("ios_xx.wake_setoff"), "moon")
        case .on: (L10n.t("ios_xx.wake_on"), "sun.max.fill")
        case .userOff: (L10n.t("ios_xx.wake_off"), "moon")
        case .paused: (L10n.t("ios_xx.wake_paused"), "pause.circle")
        }
        Button {
            switch m {
            case .setOff: keepAwake.enableSetting()
            case .on: keepAwake.setUserOff(context, true)
            case .userOff: keepAwake.setUserOff(context, false)
            case .paused: break
            }
        } label: {
            Label(text, systemImage: icon)
                .typeStyle(SATokens.TypeScale.caption)
                .padding(.horizontal, SATokens.Space.s2)
                .padding(.vertical, SATokens.Space.s1)
                .foregroundStyle(m == .on ? p.receiveInk : p.fg2)
                .background((m == .on ? p.receive : p.fg2).opacity(0.14), in: Capsule())
                .frame(minHeight: SATokens.touchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(m == .paused)
        .accessibilityAddTraits(m == .on ? .isSelected : [])
        .accessibilityHint(L10n.t("ios_xx.wake_set_p"))
        .accessibilityIdentifier("screen-on-pill")
    }
}

/// `-uiTesting` only: the real `isIdleTimerDisabled` as the value of a hidden element (docs/phases/PHASE_7_IOS.md).
struct IdleTimerProbe: View {
    @EnvironmentObject private var keepAwake: KeepAwake

    var body: some View {
        // The raw flag, re-read whenever the controller publishes, so a stuck value would show.
        let value = UIApplication.shared.isIdleTimerDisabled
        Text(value ? "true" : "false")
            .font(.system(size: 1))
            .opacity(0.02)
            .frame(width: 1, height: 1)
            .accessibilityIdentifier("test.idle-timer-disabled")
            .accessibilityValue(value ? "true" : "false")
        let bg = keepAwake.onBackground.map { $0 ? "true" : "false" } ?? ""
        Text(bg.isEmpty ? "-" : bg)
            .font(.system(size: 1))
            .opacity(0.02)
            .frame(width: 1, height: 1)
            .accessibilityIdentifier("test.idle-on-background")
            .accessibilityValue(bg)
    }
}
