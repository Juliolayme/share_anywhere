import SwiftUI

/// ON-1 Welcome (design `welcome`): value proposition, no account needed, one primary action to Transfer home.
struct WelcomeView: View {
    let onStart: () -> Void
    @Environment(\.palette) private var p

    var body: some View {
        VStack(spacing: SATokens.Space.s6) {
            Spacer()
            LogoMark(size: 72)
            VStack(spacing: SATokens.Space.s3) {
                Text("Share Anywhere").typeStyle(SATokens.TypeScale.headline).foregroundStyle(p.fg)
                Text(L10n.t("ios_vv.k130")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2).multilineTextAlignment(.center)
            }
            Label(L10n.t("product.no_account"), systemImage: "checkmark.shield")
                .typeStyle(SATokens.TypeScale.labelLg)
                .foregroundStyle(p.receiveInk)
                .padding(SATokens.Space.s3)
                .background(p.receiveSoft, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
            Spacer()
            PrimaryButton(title: L10n.t("ios_vv.k35"), action: onStart)
                .accessibilityIdentifier("welcome.start")
            Text(L10n.t("ios_vv.k144")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg3).multilineTextAlignment(.center)
        }
        .padding(SATokens.Space.s6)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(p.bg.ignoresSafeArea())
        .screenID("welcome")
    }
}
