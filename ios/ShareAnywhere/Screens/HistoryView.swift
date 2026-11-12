import SAStore
import SwiftUI

/// HI-1 History (design `history`): local entries with search, chips and filters, the "stored only on this iPhone"
/// banner, empty and no-match states, Clear history; HI-2 detail as a sheet.
struct HistoryView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @State private var filter = HistoryFilter()
    @State private var confirmClear = false

    var body: some View {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let shown = HistoryQuery.filter(model.historyEntries, filter, now: now)
        List {
            Section {
                Banner(kind: .info, title: L10n.t("ios_vv.k136"))
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("history.local")
                chips
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if !model.historyLoaded {
                ProgressView().frame(maxWidth: .infinity)
            } else if let err = model.historyError {
                Banner(kind: .danger, title: err)
            } else if model.historyEntries.isEmpty {
                EmptyState(icon: "clock", title: L10n.t("ios_yy.empty_h"), message: L10n.t("ios_yy.empty_p"))
                    .accessibilityIdentifier("history.empty")
            } else if shown.isEmpty {
                EmptyState(
                    icon: "line.3.horizontal.decrease.circle",
                    title: L10n.t("ios_yy.h_empty_h"),
                    message: L10n.t("ios_yy.h_empty_p")
                )
                .accessibilityIdentifier("history.no-match")
            } else {
                Section(header: Text(
                    shown.count == 1 ? L10n.t("product.history_results_one") : L10n
                        .t("product.history_results", ["n": "\(shown.count)"])
                ).foregroundStyle(p.fg2)) {
                    ForEach(shown) { e in
                        NavigationLink(value: e) { HistoryRow(entry: e) }
                            .accessibilityIdentifier("history.row.\(e.id)")
                            .swipeActions {
                                Button(role: .destructive) { Task { await model.deleteHistory(e.id) } } label: { Text(L10n.t("ios_yy.del"))
                                }
                            }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $filter.query, prompt: L10n.t("ios_yy.h_search"))
        .navigationTitle(L10n.t("ios.hist"))
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Picker(L10n.t("product.filter_status"), selection: $filter.status) {
                        Text(L10n.t("product.history_any_status")).tag(HistoryStatus?.none)
                        ForEach([HistoryStatus.completed, .partial, .failed, .cancelled], id: \.self) { s in
                            Text(statusLabel(s)).tag(HistoryStatus?.some(s))
                        }
                    }
                    Picker(L10n.t("product.filter_date"), selection: $filter.range) {
                        Text(L10n.t("ios_yy.f_all")).tag(HistoryRange.all)
                        Text(L10n.t("product.history_range_30d")).tag(HistoryRange.days30)
                        Text(L10n.t("product.history_range_7d")).tag(HistoryRange.days7)
                        Text(L10n.t("product.history_range_today")).tag(HistoryRange.today)
                    }
                    Picker(L10n.t("product.filter_device"), selection: $filter.peer) {
                        Text(L10n.t("product.history_all_devices")).tag(String?.none)
                        ForEach(HistoryQuery.peers(model.historyEntries), id: \.self) { Text($0).tag(String?.some($0)) }
                    }
                    if !model.historyEntries.isEmpty {
                        Divider()
                        Button(role: .destructive) { confirmClear = true } label: { Label(L10n.t("ios_yy.cb_clear"), systemImage: "trash") }
                            .accessibilityIdentifier("history.clear")
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .accessibilityLabel(L10n.t("product.filter_status"))
                }
                .accessibilityIdentifier("history.menu")
            }
        }
        .confirmationDialog(L10n.t("ios_yy.hc_h"), isPresented: $confirmClear, titleVisibility: .visible) {
            Button(L10n.t("ios_yy.cb_clear"), role: .destructive) { Task { await model.clearHistory() } }
                .accessibilityIdentifier("history.clear-confirm")
        } message: {
            Text(L10n.t("ios_yy.hc_p"))
        }
        .navigationDestination(for: HistoryEntry.self) { e in HistoryDetailView(entry: e) }
        .screenID("history")
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: SATokens.Space.s2) {
                chip(.all, L10n.t("ios_yy.f_all"))
                chip(.sent, L10n.t("ios_yy.f_sent"))
                chip(.received, L10n.t("ios_yy.f_recv"))
                chip(.failed, L10n.t("ios_yy.f_failed"))
            }
            .padding(.vertical, SATokens.Space.s2)
        }
    }

    private func chip(_ c: HistoryChip, _ title: String) -> some View {
        let on = filter.chip == c
        return Button { filter.chip = c } label: {
            Text(title)
                .typeStyle(SATokens.TypeScale.caption)
                .padding(.horizontal, SATokens.Space.s3)
                .frame(minHeight: SATokens.touchTarget)
                .foregroundStyle(on ? p.onSend : p.fg)
                .background(on ? p.send : p.surface2, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("history.chip.\(title)")
    }
}

func statusLabel(_ s: HistoryStatus) -> String {
    switch s {
    case .completed: L10n.t("ios_lbl.completed")
    case .partial: L10n.t("ios_lbl.partial")
    case .failed: L10n.t("ios_lbl.failed")
    case .cancelled: L10n.t("ios_lbl.cancelled")
    }
}

/// One entry: direction, title, peer, size and result.
struct HistoryRow: View {
    let entry: HistoryEntry
    @Environment(\.palette) private var p
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: SATokens.Space.s3) {
            Image(systemName: entry.direction == .sent ? "arrow.up.circle.fill" : "arrow.down.circle.fill")
                .font(.title)
                .foregroundStyle(entry.direction == .sent ? p.send : p.receive)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).typeStyle(SATokens.TypeScale.labelLg).foregroundStyle(p.fg)
                Text("\(entry.peer) · \(formatBytes(entry.totalBytes))").typeStyle(SATokens.TypeScale.caption).foregroundStyle(p.fg2)
                // At the accessibility text sizes the status goes under the texts instead of beside them.
                if typeSize.isAccessibilitySize { status }
            }
            Spacer()
            if !typeSize.isAccessibilitySize { status }
        }
        .padding(.vertical, SATokens.Space.s2)
        .frame(minHeight: SATokens.touchTarget)
    }

    private var status: some View {
        Chip(
            text: statusLabel(entry.status),
            color: entry.status == .completed ? p.receiveInk : entry.status == .failed ? p.dangerInk : p.warningInk,
            background: entry.status == .completed ? p.receiveSoft : entry.status == .failed ? p.dangerSoft : p.warningSoft
        )
    }
}

/// HI-2 History detail (design `history` detail sheet).
struct HistoryDetailView: View {
    let entry: HistoryEntry
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var p

    var body: some View {
        List {
            Section {
                row(L10n.t("ios_xx.h_status"), statusLabel(entry.status))
                row(L10n.t("ios_xx.h_peer"), entry.peerNames.joined(separator: ", "))
                row(
                    L10n.t("ios_xx.h_when"),
                    Date(timeIntervalSince1970: TimeInterval(entry.createdAt) / 1000).formatted(date: .abbreviated, time: .shortened)
                )
                if let moved = entry.transferred, moved != entry.totalBytes {
                    row(
                        L10n.t("ios_xx.h_size"),
                        L10n.t("product.history_partial_bytes", ["done": formatBytes(moved), "total": formatBytes(entry.totalBytes)])
                    )
                } else {
                    row(L10n.t("ios_xx.h_size"), formatBytes(entry.totalBytes))
                }
                row(L10n.t("ios_xx.h_int"), entry.status == .completed ? L10n.t("ios_xx.h_ok") : L10n.t("ios_xx.h_bad"))
            }
            if let files = entry.files, !files.isEmpty {
                Section {
                    ForEach(Array(files.enumerated()), id: \.offset) { _, f in row(f.name, formatBytes(f.size)) }
                }
            }
        }
        // Always on screen (a List does not render rows below the fold, and the action must stay reachable).
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(title: L10n.t("ios_xx.h_del"), tone: .danger) {
                Task {
                    await model.deleteHistory(entry.id)
                    dismiss()
                }
            }
            .padding(SATokens.Space.s4)
            .background(p.bg)
            .accessibilityIdentifier("history-detail.delete")
        }
        .navigationTitle(L10n.t("ios_xx.h_detail"))
        .navigationBarTitleDisplayMode(.inline)
        .screenID("history-detail")
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).foregroundStyle(p.fg2)
            Spacer()
            Text(v).foregroundStyle(p.fg).multilineTextAlignment(.trailing)
        }
        .typeStyle(SATokens.TypeScale.body)
        .accessibilityElement(children: .combine)
    }
}
