import SwiftUI
import UIKit

/// Keep screen on (docs/ARCHITECTURE.md §7, PRD §5.10): `isIdleTimerDisabled` is true only while something is sending,
/// receiving or waiting for receivers, the setting is on, and the scene is active. Screens and the transfer hub add and
/// remove reasons; pausing, finishing, cancelling, removal, a session ending, the setting going off and the app
/// leaving the screen all turn it off, and it comes back when the app is active again.
@MainActor
final class KeepAwake: ObservableObject {
    @Published private(set) var reasons: Set<String> = []
    /// The value last applied to `UIApplication.shared.isIdleTimerDisabled`.
    @Published private(set) var screenOn = false
    private(set) var enabled = true
    private var sceneActive = true

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

    func setSceneActive(_ active: Bool) {
        sceneActive = active
        apply()
    }

    private func apply() {
        let want = enabled && sceneActive && !reasons.isEmpty
        if UIApplication.shared.isIdleTimerDisabled != want { UIApplication.shared.isIdleTimerDisabled = want }
        if screenOn != want { screenOn = want }
    }
}

/// Keep-open banner with the screen-on pill (docs/ARCHITECTURE.md §7), shown on every screen that sends, receives or
/// waits for a peer. `paused` shows "Screen can sleep — paused" while this screen's transfer is paused.
struct KeepOpenBanner: View {
    var paused = false
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
            ScreenOnPill(paused: paused)
        }
        .padding(SATokens.Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p.warningSoft, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("keep-open-banner")
    }
}

struct ScreenOnPill: View {
    var paused = false
    @EnvironmentObject private var keepAwake: KeepAwake
    @Environment(\.palette) private var p

    var body: some View {
        let (text, icon, on): (String, String, Bool) = if !keepAwake.enabled {
            (L10n.t("ios_xx.wake_setoff"), "moon", false)
        } else if keepAwake.screenOn {
            (L10n.t("ios_xx.wake_on"), "sun.max.fill", true)
        } else if paused {
            (L10n.t("ios_xx.wake_paused"), "pause.circle", false)
        } else {
            (L10n.t("ios_xx.wake_off"), "moon", false)
        }
        Label(text, systemImage: icon)
            .typeStyle(SATokens.TypeScale.caption)
            .padding(.horizontal, SATokens.Space.s2)
            .padding(.vertical, SATokens.Space.s1)
            .foregroundStyle(on ? p.receiveInk : p.fg2)
            .background((on ? p.receive : p.fg2).opacity(0.14), in: Capsule())
            .accessibilityIdentifier("screen-on-pill")
    }
}

/// `-uiTesting` only: the real `isIdleTimerDisabled` as the value of a hidden element (docs/phases/PHASE_7_IOS.md).
struct IdleTimerProbe: View {
    @EnvironmentObject private var keepAwake: KeepAwake

    var body: some View {
        let value = keepAwake.screenOn && UIApplication.shared.isIdleTimerDisabled
        Text(value ? "true" : "false")
            .font(.system(size: 1))
            .opacity(0.02)
            .frame(width: 1, height: 1)
            .accessibilityIdentifier("test.idle-timer-disabled")
            .accessibilityValue(value ? "true" : "false")
    }
}
