import CoreImage.CIFilterBuiltins
import SATransferRuntime
import SwiftUI

/// Status chip text for a receiver row (TR-6) and the receive screen (RX-6).
enum TransferText {
    static func status(_ s: TxStatus) -> String {
        switch s {
        case .waiting: L10n.t("product.st_waiting")
        case .offline: L10n.t("product.st_offline")
        case .connecting: L10n.t("ios_lbl.connecting")
        case .transferring: L10n.t("ios_lbl.transferring")
        case .paused: L10n.t("ios_lbl.paused")
        case .reconnecting: L10n.t("ios_lbl.reconnecting")
        case .verifying: L10n.t("ios_lbl.verifying")
        case .completed: L10n.t("ios_lbl.completed")
        case .failed: L10n.t("ios_lbl.failed")
        case .cancelled: L10n.t("ios_lbl.cancelled")
        case .removed: L10n.t("ios_lbl.removed")
        case .blocked: L10n.t("phrases.blocked")
        }
    }

    static func phase(_ p: RxPhase, suspended: Bool) -> String {
        switch p {
        case .loading, .connecting: L10n.t("ios_lbl.connecting")
        case .choose: L10n.t("product.choose_save")
        case .transferring: L10n.t("ios_lbl.receiving")
        case .paused: L10n.t(suspended ? "ios_lbl.suspended" : "ios_lbl.paused")
        case .reconnecting, .unreachable: L10n.t("ios_lbl.reconnecting")
        case .verifying: L10n.t("ios_lbl.verifying")
        case .completed: L10n.t("ios_lbl.completed")
        case .partial: L10n.t("ios_lbl.partial")
        case .failed: L10n.t("ios_lbl.failed")
        case .cancelled: L10n.t("ios_lbl.cancelled")
        }
    }

    /// "2 min 10 s left", or "Estimating time…" while the estimate is provisional.
    static func eta(_ seconds: Int64?) -> String {
        guard let s = seconds, s >= 0 else { return L10n.t("ios.estimating") }
        let time = if s >= 3600 {
            L10n.t("product.eta_hm", ["h": "\(s / 3600)", "m": "\((s % 3600) / 60)"])
        } else if s >= 60 {
            L10n.t("product.eta_ms", ["m": "\(s / 60)", "s": "\(s % 60)"])
        } else {
            L10n.t("product.eta_s", ["s": "\(s)"])
        }
        return L10n.t("product.eta_left", ["time": time])
    }

    static func speed(_ bps: Double) -> String { L10n.t("product.per_second", ["size": formatBytes(Int64(bps))]) }

    static func files(_ n: Int) -> String { n == 1 ? L10n.t("product.files_count_one") : L10n.t("product.files_count", ["n": "\(n)"]) }

    static func route(_ r: String?) -> String? {
        switch r {
        case "direct": L10n.t("product.route_direct")
        case "relay": L10n.t("product.route_relay")
        default: nil
        }
    }

    /// "1:05" for a countdown.
    static func clock(_ seconds: Int) -> String { String(format: "%d:%02d", max(0, seconds) / 60, max(0, seconds) % 60) }

    /// The six digits with a thin gap ("123 456"), as the design shows them.
    static func code(_ c: String) -> String { c.count == 6 ? "\(c.prefix(3)) \(c.suffix(3))" : c }
}

/// A token-coloured linear progress bar with an accessibility value in percent.
struct TransferBar: View {
    let done: Int64
    let total: Int64
    var tint: Color?
    @Environment(\.palette) private var p

    var body: some View {
        let fraction = total > 0 ? min(1, Double(done) / Double(total)) : (done > 0 ? 1 : 0)
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(p.track)
                Capsule().fill(tint ?? p.send).frame(width: g.size.width * fraction)
            }
        }
        .frame(height: 6)
        .accessibilityElement()
        .accessibilityValue("\(Int(fraction * 100))%")
    }
}

/// A QR code for the join link (CoreImage `CIQRCodeGenerator`), drawn without smoothing.
struct QRCodeView: View {
    let text: String

    var body: some View {
        if let image = QRCodeView.make(text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(SATokens.Space.s3)
                .background(Color.white, in: RoundedRectangle(cornerRadius: SATokens.Radius.md))
        }
    }

    static func make(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// Security words in a row (docs/SECURITY_MODEL.md: both sides see the same words).
struct SecurityWords: View {
    let caption: String
    let words: [String]
    @Environment(\.palette) private var p

    var body: some View {
        if !words.isEmpty {
            VStack(alignment: .leading, spacing: SATokens.Space.s1) {
                Text(caption).typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                Text(words.joined(separator: " · ")).typeStyle(SATokens.TypeScale.code).foregroundStyle(p.fg)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("security-words")
        }
    }
}

/// Maps an API error to a catalog string for the code and join screens.
enum JoinErrors {
    static func message(_ error: any Error) -> String {
        guard let e = error as? APIError else { return L10n.t("ios_yy.off_h") }
        switch e.code {
        case "code_not_found": return L10n.t("ios_yy.nf_rx")
        case "join_window_expired", "join_ticket_invalid", "link_not_found": return L10n.t("ios_yy.cx_rx")
        case "session_full": return L10n.t("product.session_full_rx")
        case "session_not_accepting": return L10n.t("product.not_accepting_rx")
        case "own_session": return L10n.t("product.own_session")
        case "session_expired", "not_found": return L10n.t("product.session_ended_rx")
        case "blocked": return L10n.t("product.blocked_rx")
        default:
            if e.status == 429 || e.code == "locked_out" || e.code == "rate_limited" {
                let s = e.retryAfterSeconds ?? 60
                return L10n.t("product.rate_limited", ["time": TransferText.clock(s)])
            }
            return L10n.t("product.error_generic")
        }
    }
}

/// Six-digit codes and share links (docs/API.md §2.2), as Android's `normalizeCode` and `linkTokenFrom`.
enum JoinInput {
    static func code(_ raw: String) -> String { String(raw.filter(\.isASCII).filter(\.isNumber).prefix(6)) }

    /// The capability token from `<public origin>/j/<token>`; links to any other origin are refused, so a QR code
    /// cannot point the app somewhere else.
    static func linkToken(_ raw: String, publicOrigin: URL) -> String? {
        guard let url = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let origin = URLComponents(url: publicOrigin, resolvingAgainstBaseURL: false),
              url.scheme?.lowercased() == origin.scheme?.lowercased(), url.host?.lowercased() == origin.host?.lowercased(),
              url.port == origin.port, url.query == nil, url.fragment == nil else { return nil }
        let segs = url.path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        guard segs.count == 2, segs.first == "j", let token = segs.last else { return nil }
        let ok = (22 ... 128).contains(token.count) && token
            .allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
        return ok ? String(token) : nil
    }
}

/// A device platform as people write it ("iOS", not "Ios").
func platformName(_ p: String) -> String {
    switch p.lowercased() {
    case "ios": "iOS"
    case "android": "Android"
    case "web": "Web"
    default: p.capitalized
    }
}
