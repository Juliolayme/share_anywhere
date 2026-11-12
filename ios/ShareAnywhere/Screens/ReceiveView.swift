import AVFoundation
import SATransferRuntime
import SwiftUI
import Vision

/// RX-1 / RX-2 Receive (design `receive` scan, `receive-code`): scan the sender's QR with the camera (a real device;
/// the simulator has no camera and opens on code entry) or type the six-digit code. A link or code resolves to the
/// join preview (RX-4).
struct ReceiveView: View {
    enum Mode: Hashable { case scan, code }
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @State private var mode: Mode = ScannerSupport.hasCamera ? .scan : .code
    @State private var code = ""
    @State private var resolving = false
    @State private var error: String?
    @FocusState private var focused: Bool
    /// The camera runs only while this screen is on top (a pushed preview stops it).
    @State private var visible = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SATokens.Space.s4) {
                Picker(L10n.t("ios.receive"), selection: $mode) {
                    Text(L10n.t("ios.scan")).tag(Mode.scan)
                    Text(L10n.t("ios.entercode")).tag(Mode.code)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("receive.mode")
                if mode == .scan { scan } else { entry }
            }
            .padding(SATokens.Space.s4)
        }
        .background(p.bg.ignoresSafeArea())
        .navigationTitle(L10n.t("ios.receive"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .screenID(mode == .scan ? "receive" : "receive-code")
    }

    @ViewBuilder private var scan: some View {
        ScannerPanel(active: visible && !resolving) { text in
            if let token = JoinInput.linkToken(text, publicOrigin: model.config.publicURL) {
                resolve { try await model.hub.services.resolveLink(token) }
            } else {
                error = L10n.t("product.qr_not_share_link")
            }
        } enterCode: { mode = .code }
        if let error { Banner(kind: .danger, title: error).accessibilityIdentifier("receive.error") }
        if resolving { ProgressView().frame(maxWidth: .infinity) }
    }

    @ViewBuilder private var entry: some View {
        Text(L10n.t("product.code_enter_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
        TextField(L10n.t("ios.code"), text: $code)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .font(.system(size: 34, weight: .semibold, design: .monospaced))
            .multilineTextAlignment(.center)
            .padding(SATokens.Space.s3)
            .background(p.surface, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
            .overlay(RoundedRectangle(cornerRadius: SATokens.Radius.md).stroke(error == nil ? p.border : p.danger))
            .focused($focused)
            .onChange(of: code) { v in
                let clean = JoinInput.code(v)
                if clean != v { code = clean }
                error = nil
            }
            .accessibilityLabel(L10n.t("product.code_digits_aria"))
            .accessibilityIdentifier("receive.code-input")
        if let error { Banner(kind: .danger, title: error).accessibilityIdentifier("receive.error") }
        PrimaryButton(title: L10n.t("ios.cont"), tone: .receive, enabled: code.count == 6 && !resolving) {
            let c = code
            resolve { try await model.hub.services.resolveCode(c) }
        }
        .accessibilityIdentifier("receive.continue")
        if resolving { ProgressView().frame(maxWidth: .infinity) }
    }

    private func resolve(_ call: @escaping () async throws -> JoinPreview) {
        resolving = true
        error = nil
        Task {
            defer { resolving = false }
            do {
                let preview = try await call()
                model.previews[preview.sessionId] = preview
                model.homePath.append(.preview(preview.sessionId))
            } catch {
                self.error = JoinErrors.message(error)
            }
        }
    }
}

enum ScannerSupport {
    static var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }
}

/// The camera states (RX-1): ask, denied with a link to Settings, unavailable, scanning.
struct ScannerPanel: View {
    var active = true
    let onCode: (String) -> Void
    let enterCode: () -> Void
    @Environment(\.palette) private var p
    @Environment(\.openURL) private var openURL
    @State private var status = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        if !ScannerSupport.hasCamera {
            Banner(
                kind: .info,
                title: L10n.t("product.camera_unavailable"),
                actionTitle: L10n.t("product.scan_code_instead"),
                action: enterCode
            )
            .accessibilityIdentifier("receive.camera-unavailable")
        } else {
            switch status {
            case .authorized where active:
                QRScanner(onCode: onCode)
                    .aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: SATokens.Radius.lg))
                    .accessibilityLabel(L10n.t("product.scan_viewfinder"))
                Text(L10n.t("product.scan_point")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
            case .authorized:
                ProgressView().frame(maxWidth: .infinity)
            case .notDetermined:
                Card {
                    Text(L10n.t("product.camera_needed_h")).typeStyle(SATokens.TypeScale.title)
                    Text(L10n.t("product.camera_needed_p")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                    PrimaryButton(title: L10n.t("product.camera_allow"), tone: .receive) {
                        AVCaptureDevice.requestAccess(for: .video) { _ in
                            Task { @MainActor in status = AVCaptureDevice.authorizationStatus(for: .video) }
                        }
                    }
                }
            default:
                Card {
                    Text(L10n.t("product.camera_denied_h")).typeStyle(SATokens.TypeScale.title)
                    Text(L10n.t("product.camera_denied_p_ios")).typeStyle(SATokens.TypeScale.body).foregroundStyle(p.fg2)
                    SecondaryButton(title: L10n.t("product.open_settings")) {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                }
            }
            Button(L10n.t("product.scan_code_instead"), action: enterCode)
                .frame(minHeight: SATokens.touchTarget)
                .accessibilityIdentifier("receive.enter-code")
        }
    }
}

/// `AVCaptureSession` frames through `VNDetectBarcodesRequest` (QR only); reports the first payload once.
struct QRScanner: UIViewRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = context.coordinator.session
        view.previewLayer.videoGravity = .resizeAspectFill
        context.coordinator.start()
        return view
    }

    func updateUIView(_: PreviewView, context _: Context) {}

    static func dismantleUIView(_: PreviewView, coordinator: Coordinator) { coordinator.stop() }

    final class PreviewView: UIView {
        override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer {
            // swiftlint:disable:next force_cast
            layer as! AVCaptureVideoPreviewLayer
        }
    }

    final class Coordinator: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
        let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "qr-scanner")
        private let onCode: (String) -> Void
        private var done = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func start() {
            queue.async { [self] in
                guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
                      session.canAddInput(input) else { return }
                session.beginConfiguration()
                session.addInput(input)
                let output = AVCaptureVideoDataOutput()
                output.alwaysDiscardsLateVideoFrames = true
                output.setSampleBufferDelegate(self, queue: queue)
                if session.canAddOutput(output) { session.addOutput(output) }
                session.commitConfiguration()
                session.startRunning()
            }
        }

        func stop() { queue.async { [self] in session.stopRunning() } }

        func captureOutput(_: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from _: AVCaptureConnection) {
            guard !done, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            let request = VNDetectBarcodesRequest()
            request.symbologies = [.qr]
            try? VNImageRequestHandler(cvPixelBuffer: pixels, options: [:]).perform([request])
            guard let payload = request.results?.compactMap(\.payloadStringValue).first else { return }
            done = true
            DispatchQueue.main.async { [onCode] in onCode(payload) }
            queue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.done = false }
        }
    }
}
