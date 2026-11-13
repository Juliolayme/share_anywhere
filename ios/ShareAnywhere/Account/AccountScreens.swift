import SAAccount
import SwiftUI

/// The account sheet (docs/UX_SCREEN_MAP.md AC-1…AC-8, iOS column): presented only from account CTAs (Settings Sign
/// in, Clipboard, Devices), never from a transfer. Sign in or create an account, choose to add this device, then set up
/// the encryption key, get it from another device or the recovery phrase, and finish on the checklist.
struct AccountSheet: View {
    enum Step: Hashable { case signIn, signUp, forgot, trust, keySetup, keyPair, phrase, checklist }
    let start: Step
    @EnvironmentObject private var account: AccountSession
    @Environment(\.dismiss) private var dismiss
    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            screen(start)
                .navigationDestination(for: Step.self) { screen($0) }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(L10n.t("ios_yy.close")) { dismiss() }.accessibilityIdentifier("account.close")
                    }
                }
        }
        // Pushed screens (Not now on Add this device, Go to Clipboard) close the sheet, not just themselves.
        .environment(\.closeAccountSheet, CloseAccountSheet { dismiss() })
        .themed()
    }

    @ViewBuilder private func screen(_ s: Step) -> some View {
        switch s {
        case .signIn: SignInView(path: $path)
        case .signUp: SignUpView(path: $path)
        case .forgot: ForgotView()
        case .trust: TrustView(path: $path)
        case .keySetup: KeySetupView(path: $path)
        case .keyPair: KeyPairView(path: $path)
        case .phrase: PhraseView(path: $path)
        case .checklist: ChecklistView()
        }
    }
}

/// After a sign-in or sign-up: where the key step leads (AC-4, then AC-5 / AC-6 / AC-8).
@MainActor
func nextStep(for status: KeyStatus) -> AccountSheet.Step {
    switch status {
    case .setup: .keySetup
    case .pair: .keyPair
    default: .checklist
    }
}

/// Closes the whole account sheet from any screen pushed inside it (`dismiss` there only pops that screen).
struct CloseAccountSheet {
    let action: () -> Void
    func callAsFunction() { action() }
}

private struct CloseAccountSheetKey: EnvironmentKey {
    static let defaultValue = CloseAccountSheet {}
}

extension EnvironmentValues {
    var closeAccountSheet: CloseAccountSheet {
        get { self[CloseAccountSheetKey.self] }
        set { self[CloseAccountSheetKey.self] = newValue }
    }
}

/// A labelled text field in the account forms.
struct FormField: View {
    let label: String
    @Binding var text: String
    var secure = false
    var content: UITextContentType?
    var id: String
    @Environment(\.palette) private var p

    var body: some View {
        VStack(alignment: .leading, spacing: SATokens.Space.s1) {
            Text(label).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            // Under UI tests a new-password field is a plain field: iOS password AutoFill takes over a secure field on a
            // sign-up form on the simulator and swallows the typed text.
            let testEntry = content == .newPassword && AppConfig.uiTestingProcess
            Group {
                if secure, !testEntry { SecureField(label, text: $text) } else { TextField(label, text: $text) }
            }
            .textContentType(testEntry ? nil : content)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(content == .emailAddress ? .emailAddress : .default)
            .padding(SATokens.Space.s3)
            .frame(minHeight: SATokens.touchTarget)
            .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
            .overlay(RoundedRectangle(cornerRadius: SATokens.Radius.md).stroke(p.border))
            .accessibilityIdentifier(id)
        }
    }
}

struct SignInView: View {
    @Binding var path: [AccountSheet.Step]
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                Text(L10n.t("ios_yy.si_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                FormField(label: L10n.t("ios_yy.email"), text: $email, content: .emailAddress, id: "signin.email")
                FormField(label: L10n.t("ios_yy.pw"), text: $password, secure: true, content: .password, id: "signin.password")
                if let error { Banner(kind: .danger, title: error).accessibilityIdentifier("signin.error") }
                PrimaryButton(title: L10n.t("ios_yy.signin"), enabled: !busy && !email.isEmpty && !password.isEmpty) { submit() }
                    .accessibilityIdentifier("signin.submit")
                Button(L10n.t("ios_yy.forgot")) { path.append(.forgot) }.frame(minHeight: SATokens.touchTarget)
                Button(L10n.t("ios_yy.create")) { path.append(.signUp) }.frame(minHeight: SATokens.touchTarget)
                    .accessibilityIdentifier("signin.create")
                Text(L10n.t("ios_vv.k144")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios_yy.signin"))
        .screenID("signin")
    }

    private func submit() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await account.manager.signIn(email: email, password: password, addDevice: false)
                path.append(.trust)
            } catch {
                self.error = AccountErrors.message(error)
            }
        }
    }
}

struct SignUpView: View {
    @Binding var path: [AccountSheet.Step]
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                Text(L10n.t("ios_yy.su_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                FormField(label: L10n.t("ios_yy.email"), text: $email, content: .emailAddress, id: "signup.email")
                FormField(label: L10n.t("ios_yy.pw"), text: $password, secure: true, content: .newPassword, id: "signup.password")
                Text(L10n.t("product.acct_weak_password")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                if let error { Banner(kind: .danger, title: error).accessibilityIdentifier("signup.error") }
                PrimaryButton(title: L10n.t("ios_yy.create"), enabled: !busy && !email.isEmpty && password.count >= 10) { submit() }
                    .accessibilityIdentifier("signup.submit")
                Button(L10n.t("ios_yy.have")) { path.removeAll() }.frame(minHeight: SATokens.touchTarget)
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios_yy.su_h"))
        .screenID("signup")
    }

    private func submit() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await account.manager.signUp(email: email, password: password, addDevice: false)
                path.append(.trust)
            } catch {
                self.error = AccountErrors.message(error)
            }
        }
    }
}

struct ForgotView: View {
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var email = ""
    @State private var sent = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                if sent {
                    Text(L10n.t("ios_yy.fp_sent_h")).typeStyle(SATokens.TypeScale.title).foregroundStyle(p.fg)
                    Text(L10n.t("ios_yy.fp_sent_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                    Text(L10n.t("product.fp_open_link")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                } else {
                    Text(L10n.t("ios_yy.fp_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                    FormField(label: L10n.t("ios_yy.email"), text: $email, content: .emailAddress, id: "forgot.email")
                    if let error { Banner(kind: .danger, title: error) }
                    PrimaryButton(title: L10n.t("ios_yy.fp_btn"), enabled: !busy && email.contains("@")) {
                        busy = true
                        Task {
                            defer { busy = false }
                            do {
                                try await account.manager.requestReset(email: email)
                                sent = true
                            } catch { self.error = AccountErrors.message(error) }
                        }
                    }
                    .accessibilityIdentifier("forgot.submit")
                }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios_yy.fp_h"))
        .screenID("forgot")
    }
}

/// AC-4: add this device to the account (default on) and, optionally, copy its transfer history once.
struct TrustView: View {
    @Binding var path: [AccountSheet.Step]
    @EnvironmentObject private var account: AccountSession
    @Environment(\.closeAccountSheet) private var closeSheet
    @Environment(\.palette) private var p
    @State private var add = true
    @State private var copyHistory = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                if let email = account.state.email {
                    Chip(text: L10n.t("product.account_chip", ["email": email])).accessibilityIdentifier("trust.email")
                }
                Toggle(isOn: $add) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L10n.t("product.add_device")).typeStyle(SATokens.TypeScale.labelLg)
                        Text(L10n.t(add ? "product.add_device_p" : "product.add_device_off_p_device")).typeStyle(SATokens.TypeScale.caption)
                            .foregroundStyle(p.fg2)
                    }
                }
                .accessibilityIdentifier("trust.add")
                if add {
                    Toggle(isOn: $copyHistory) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L10n.t("product.copy_history")).typeStyle(SATokens.TypeScale.labelLg)
                            Text(L10n.t("product.copy_history_p")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                        }
                    }
                    .accessibilityIdentifier("trust.copy-history")
                }
                if let error { Banner(kind: .danger, title: error) }
                PrimaryButton(title: L10n.t("ios.cont"), enabled: !busy) { submit() }.accessibilityIdentifier("trust.continue")
                if busy { ProgressView().frame(maxWidth: .infinity) }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios_yy.trusted"))
        .navigationBarBackButtonHidden(true)
        .screenID("trust")
    }

    private func submit() {
        guard add else { return closeSheet() }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let status = try await account.manager.addThisDevice(copyHistory: copyHistory)
                path.append(nextStep(for: status))
            } catch {
                self.error = L10n.t("product.add_device_failed")
            }
        }
    }
}

/// AC-5 on iOS: the first device of an account creates the key and shows the recovery phrase; nothing reaches the
/// server until "I wrote down my recovery phrase".
struct KeySetupView: View {
    @Binding var path: [AccountSheet.Step]
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var prepared: KeyFlows.PreparedSetup?
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var saved = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                Text(L10n.t("product.key_setup_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                if let prepared {
                    let words = prepared.phrase.split(separator: " ").map(String.init)
                    // One column at the accessibility text sizes: two 28 pt columns do not fit a phone.
                    // A non-lazy grid whose cells grow taller: a word never clips at a larger text size.
                    let columns = typeSize.isAccessibilitySize ? 1 : 2
                    Grid(alignment: .topLeading, horizontalSpacing: SATokens.Space.s2, verticalSpacing: SATokens.Space.s2) {
                        ForEach(0 ..< (words.count + columns - 1) / columns, id: \.self) { row in
                            GridRow {
                                ForEach(0 ..< columns, id: \.self) { col in
                                    let i = row * columns + col
                                    if i < words.count {
                                        Text("\(i + 1). \(words[i])").typeStyle(SATokens.TypeScale.code).foregroundStyle(p.fg)
                                            .fixedSize(horizontal: false, vertical: true)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(SATokens.Space.s2)
                                            .background(p.surface2, in: RoundedRectangle(cornerRadius: SATokens.Radius.sm))
                                    } else {
                                        Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                                    }
                                }
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(L10n.t("product.key_words_label"))
                    .accessibilityValue(prepared.phrase)
                    .accessibilityIdentifier("key-setup.phrase")
                    Banner(kind: .warning, title: L10n.t("product.key_setup_warn"))
                    Toggle(L10n.t("product.key_saved_check"), isOn: $saved).accessibilityIdentifier("key-setup.saved")
                    PrimaryButton(title: L10n.t("ios.cont"), enabled: saved && !busy) { commit(prepared) }
                        .accessibilityIdentifier("key-setup.continue")
                } else if error == nil {
                    HStack(spacing: SATokens.Space.s3) {
                        ProgressView().accessibilityHidden(true)
                        Text(L10n.t("product.key_generating")).typeStyle(SATokens.TypeScale.body)
                    }
                }
                if let error {
                    Banner(kind: .danger, title: error, actionTitle: L10n.t("ios_yy.retry")) { prepare() }
                }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("product.key_setup_h"))
        .navigationBarBackButtonHidden(true)
        .task { if prepared == nil { prepare() } }
        .screenID("key-setup")
    }

    private func prepare() {
        error = nil
        Task {
            do { prepared = try await account.manager.prepareKeys() } catch { self.error = L10n.t("product.key_setup_failed") }
        }
    }

    private func commit(_ p: KeyFlows.PreparedSetup) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await account.manager.commitKeys(p)
                path.append(.checklist)
            } catch let e as APIError where e.code == "keys_exist" {
                error = L10n.t("product.key_exists")
                path.append(.keyPair)
            } catch {
                self.error = AccountErrors.message(error)
            }
        }
    }
}

/// AC-6 on iOS: this (new) device shows a pairing code and QR for one of the account's devices, then stores the key
/// it sends; or uses the recovery phrase.
struct KeyPairView: View {
    @Binding var path: [AccountSheet.Step]
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var start: AccountKeys.PairingStart?
    @State private var status = "waiting"
    @State private var error: String?
    @State private var poll: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                Text(L10n.t("product.pair_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                if let start, status == "waiting" {
                    QRCodeView(text: start.payload).frame(maxWidth: 220).frame(maxWidth: .infinity)
                        .accessibilityLabel(L10n.t("product.pair_qr_aria"))
                    Text(L10n.t("product.pair_code_label")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                    Text(start.payload).typeStyle(SATokens.TypeScale.code).textSelection(.enabled)
                        .accessibilityLabel(L10n.t("product.pair_code_label"))
                        .accessibilityIdentifier("key-pair.code").accessibilityValue(start.payload)
                    SecondaryButton(title: L10n.t("product.pair_copy_code")) { account.copy(start.payload) }
                    Text(L10n.t("product.pair_steps")).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                    HStack(spacing: SATokens.Space.s2) {
                        ProgressView().accessibilityHidden(true)
                        Text(L10n.t("product.pair_waiting")).typeStyle(SATokens.TypeScale.body)
                    }
                } else if status == "expired" {
                    Banner(kind: .warning, title: L10n.t("product.pair_expired"), actionTitle: L10n.t("product.pair_new_code")) { begin() }
                } else if start == nil, error == nil {
                    ProgressView().frame(maxWidth: .infinity)
                }
                if let error { Banner(kind: .danger, title: error, actionTitle: L10n.t("product.pair_again")) { begin() } }
                Button(L10n.t("product.phrase_h")) { path.append(.phrase) }.frame(minHeight: SATokens.touchTarget)
                    .accessibilityIdentifier("key-pair.phrase")
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("product.pair_h"))
        .navigationBarBackButtonHidden(true)
        .task { if start == nil { begin() } }
        // Back from the recovery phrase screen: watch the same code again.
        .onAppear { if let start, status == "waiting", poll == nil || poll?.isCancelled == true { watch(start) } }
        .onDisappear { poll?.cancel() }
        .screenID("key-pair")
    }

    private func begin() {
        poll?.cancel()
        error = nil
        status = "waiting"
        Task {
            do {
                let s = try await account.manager.startPairing()
                start = s
                watch(s)
            } catch {
                self.error = AccountErrors.message(error)
            }
        }
    }

    private func watch(_ s: AccountKeys.PairingStart) {
        poll = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let st = try? await account.manager.pairingStatus(s.pairingID) else { continue }
                if st.status == "expired" {
                    status = "expired"
                    return
                }
                if st.status == "ready" {
                    do {
                        _ = try await account.manager.finishPairing(s, ready: st)
                        path.append(.checklist)
                    } catch {
                        self.error = (error as? CryptoError)?.code == "untrusted_sender" ? L10n.t("product.pair_untrusted") : L10n
                            .t("product.pair_failed")
                    }
                    return
                }
            }
        }
    }
}

/// The recovery phrase instead of another device (AC-6 phrase).
struct PhraseView: View {
    @Binding var path: [AccountSheet.Step]
    @EnvironmentObject private var account: AccountSession
    @Environment(\.palette) private var p
    @State private var phrase = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                Text(L10n.t("product.phrase_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                TextField(L10n.t("product.phrase_label"), text: $phrase, axis: .vertical)
                    .lineLimit(3 ... 6)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(SATokens.Space.s3)
                    .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
                    .accessibilityIdentifier("phrase.input")
                let count = Phrase.normalize(phrase).split(separator: " ").count
                Text(L10n.t("product.phrase_count", ["n": "\(count)"])).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                if let problem = count == 12 ? Phrase.check(phrase) : nil {
                    Text(problem.word.map { L10n.t("product.phrase_unknown", ["word": $0]) } ?? L10n.t("product.phrase_checksum"))
                        .typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.dangerInk)
                }
                if let error { Banner(kind: .danger, title: error) }
                PrimaryButton(
                    title: busy ? L10n.t("product.phrase_unlocking", ["percent": "…"]) : L10n.t("product.phrase_unlock"),
                    enabled: !busy && count == 12 && Phrase.check(phrase) == nil
                ) { unlock() }
                    .accessibilityIdentifier("phrase.unlock")
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("product.phrase_h"))
        .screenID("key-pair.phrase")
    }

    private func unlock() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await account.manager.recover(phrase: phrase)
                path.append(.checklist)
            } catch {
                self.error = AccountErrors.message(error)
            }
        }
    }
}

/// AC-8 after sign-in: what is set up now.
struct ChecklistView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var account: AccountSession
    @Environment(\.closeAccountSheet) private var closeSheet
    @Environment(\.palette) private var p

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                Text(L10n.t("ios_yy.ck_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                row(L10n.t("ios_yy.ck_1"), true)
                row(L10n.t("ios_yy.ck_2"), account.state.signedIn)
                row(L10n.t("ios_yy.ck_3"), account.state.added && account.state.keys == .ready)
                PrimaryButton(title: L10n.t("ios_yy.ck_btn")) {
                    model.tab = .clipboard
                    closeSheet()
                }
                .accessibilityIdentifier("checklist.clipboard")
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios_yy.ck_h"))
        .navigationBarBackButtonHidden(true)
        .screenID("checklist")
    }

    private func row(_ text: String, _ done: Bool) -> some View {
        Label(text, systemImage: done ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(done ? p.receiveInk : p.fg2)
            .typeStyle(SATokens.TypeScale.body)
            .frame(minHeight: SATokens.touchTarget, alignment: .leading)
    }
}
