import Charts
import SwiftData
import SwiftUI

/// US-1128 — per-listing eBay performance, the iOS counterpart of the web
/// Listing Performance dashboard (`src/pages/flipdesk/listing-performance.tsx`).
/// Shows views, watchers, 7-day impressions and click-through per active eBay
/// listing over the same `listings` metrics eBay's Sell Analytics pushes. When
/// eBay hasn't granted the analytics scope it degrades gracefully and prompts a
/// reconnect (mirroring the web banner). Reached from the Analytics screen.
struct ListingPerformanceView: View {
    /// Used by the reconnect prompt to jump to the Marketplaces tab. Optional so
    /// previews/tests don't need a router.
    var router: AppRouter? = nil

    // Title fallback comes from the local inventory mirror (same join the web
    // does against `inventory_items`) — no second network round-trip.
    @Query private var items: [LocalInventoryItem]

    @State private var store = ListingPerformanceStore()
    @State private var sort: ListingPerformanceSort = .views
    @State private var ascending = false
    /// nil = chip off; otherwise the N-day no-views window.
    @State private var noViewDays: Int?

    private let currency = CurrencyFormatter()

    var body: some View {
        Group {
            switch store.phase {
            case .loading:
                loadingState
            case let .failed(message):
                ErrorStateView(message: message, retry: { await store.load() })
            case let .loaded(rows):
                content(rows)
            }
        }
        .navigationTitle("Listing Performance")
        .navigationBarTitleDisplayMode(.inline)
        .background(Color(uiColor: .systemGroupedBackground))
        .task {
            if case .loading = store.phase { await store.load() }
        }
    }

    // MARK: - Loading

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Loading listing performance…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
        // US-1223: the bare spinner is silent to VoiceOver — combine it with the
        // caption and speak a "Loading" cue.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Loading")
        .accessibilityAddTraits(.updatesFrequently)
    }

    // MARK: - Content

    private func content(_ rows: [ListingPerformanceRow]) -> some View {
        let resolved = ListingPerformance.resolve(
            rows,
            sort: sort,
            ascending: ascending,
            minNoViewDays: noViewDays,
            titleFor: title(for:)
        )
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if store.analyticsDenied { reconnectBanner }
                controls(total: resolved.count)
                if resolved.isEmpty {
                    emptyState
                } else {
                    VStack(spacing: 10) {
                        ForEach(resolved) { row in
                            listingRow(row)
                        }
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await store.load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Views, watchers and impressions per active eBay listing. Spot duds before they age out.")
                .font(.brandCaption)
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.caption2)
                Text("Synced \(syncedRelative) · auto every 6h")
                    .font(.caption2)
            }
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // US-1128: graceful degradation — eBay hasn't granted Sell Analytics, so
    // metrics can't be pulled. Mirrors the web reconnect banner.
    private var reconnectBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.brandAmber)
                Text("eBay hasn't granted Sell Analytics access, so views, impressions and click-through can't be pulled. Reconnect your eBay account to enable performance metrics.")
                    .font(.footnote)
                    .foregroundStyle(.primary)
            }
            Button("Reconnect eBay") {
                AppRouter.haptic()
                router?.selection = .marketplaces
            }
            .buttonStyle(.brandSecondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.brandAmber.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.brandAmber.opacity(0.35), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private func controls(total: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Active listings")
                    .font(.brandHeadline)
                Text("\(total)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Color.brandNavy.opacity(0.10), in: Capsule())
                    .foregroundStyle(Color.brandNavy)
                Spacer()
                sortMenu
            }
            // "No views in N days" quick filters (web `NO_VIEW_WINDOWS`).
            HStack(spacing: 8) {
                Text("No views in:")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                ForEach(ListingPerformance.noViewWindows, id: \.self) { n in
                    Button {
                        AppRouter.haptic()
                        noViewDays = (noViewDays == n) ? nil : n
                    } label: {
                        Text("\(n) days")
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                    }
                    .background(
                        noViewDays == n ? Color.brandNavy : Color.clear,
                        in: Capsule()
                    )
                    .foregroundStyle(noViewDays == n ? .white : Color.primary)
                    .overlay(
                        Capsule().stroke(Color.secondary.opacity(0.3), lineWidth: noViewDays == n ? 0 : 1)
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sortMenu: some View {
        Menu {
            ForEach(ListingPerformanceSort.allCases) { option in
                Button {
                    if sort == option {
                        ascending.toggle()
                    } else {
                        sort = option
                        ascending = option.defaultAscending
                    }
                } label: {
                    if sort == option {
                        Label(option.label, systemImage: ascending ? "chevron.up" : "chevron.down")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.arrow.down")
                Text(sort.label)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(Color.brandNavy)
        }
        .accessibilityLabel("Sort by \(sort.label)")
    }

    // MARK: - Row

    private func listingRow(_ row: ListingPerformanceRow) -> some View {
        let stale = ListingPerformance.isStale(row)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(for: row))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    HStack(spacing: 8) {
                        Text(currency.formatDisplay(row.listingPrice))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text("· \(ListingPerformance.daysListed(row.listedAt))d listed")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if let urlString = row.listingURL, let url = URL(string: urlString) {
                    Link(destination: url) {
                        Image(systemName: "arrow.up.right.square")
                            .font(.body)
                            .foregroundStyle(Color.brandNavy)
                    }
                    .accessibilityLabel("View on eBay")
                }
            }

            sparkline(row.viewTrend7d)

            HStack(spacing: 0) {
                metric("Views", value: viewsText(row), highlight: stale)
                Divider().frame(height: 28)
                metric("Watchers", value: countText(row.watchersCount))
                Divider().frame(height: 28)
                metric("Impr. 7d", value: countText(row.impressions7d))
                Divider().frame(height: 28)
                metric("CTR", value: ctrText(row.clickThroughRate))
            }
        }
        .padding(14)
        .cardStyle(.flush)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: row))
    }

    private func metric(_ label: String, value: String, highlight: Bool = false) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.brandData(15, weight: .bold))
                .foregroundStyle(highlight ? Color.brandRed : .primary)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func sparkline(_ trend: [ListingPerformanceRow.TrendPoint]) -> some View {
        if trend.count >= 2 {
            // Rising reads positive (navy); flat/falling stays muted — same cue
            // as the web sparkline.
            let first = trend.first?.views ?? 0
            let last = trend.last?.views ?? 0
            let rising = last >= first
            Chart(Array(trend.enumerated()), id: \.offset) { item in
                LineMark(
                    x: .value("Day", item.offset),
                    y: .value("Views", item.element.views)
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(rising ? Color.brandNavy : Color.secondary)
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .frame(height: 28)
            // US-1223: the rising/falling cue was conveyed by line color only.
            // Fold the direction into the label so VoiceOver speaks it.
            .accessibilityLabel("7-day view trend, \(trendDirection(first: first, last: last))")
        }
    }

    /// Spoken trend direction for the sparkline (color-independent).
    private func trendDirection(first: Int, last: Int) -> String {
        if last > first { return "rising" }
        if last < first { return "falling" }
        return "flat"
    }

    // MARK: - Empty

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                noViewDays == nil ? "No active eBay listings" : "Nothing matches",
                systemImage: "eye.slash"
            )
        } description: {
            Text(
                noViewDays == nil
                    ? "Publish a listing to start tracking views, watchers and click-through."
                    : "No active listings with zero views in \(noViewDays ?? 0)+ days. Nice."
            )
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
    }

    // MARK: - Derivation

    private var titleByItemId: [String: String] {
        Dictionary(items.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
    }

    private func title(for row: ListingPerformanceRow) -> String {
        if let t = row.listingTitle, !t.isEmpty { return t }
        if let t = titleByItemId[row.inventoryItemId], !t.isEmpty { return t }
        return "Untitled item"
    }

    private var syncedRelative: String {
        guard let date = store.lastSyncedAt else { return "never" }
        let mins = Int(Date.now.timeIntervalSince(date) / 60)
        if mins < 1 { return "just now" }
        if mins < 60 { return "\(mins)m ago" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs)h ago" }
        return "\(hrs / 24)d ago"
    }

    private func viewsText(_ row: ListingPerformanceRow) -> String {
        ListingPerformance.isStale(row) ? "0" : countText(row.viewsTotal)
    }

    private func countText(_ n: Int) -> String {
        n.formatted()
    }

    private func ctrText(_ ctr: Double?) -> String {
        guard let ctr, ctr.isFinite else { return "—" }
        return String(format: "%.1f%%", ctr * 100)
    }

    private func accessibilityLabel(for row: ListingPerformanceRow) -> String {
        var label = "\(title(for: row)). \(countText(row.viewsTotal)) views, "
            + "\(countText(row.watchersCount)) watchers, "
            + "\(countText(row.impressions7d)) impressions in 7 days, "
            + "\(ctrText(row.clickThroughRate)) click-through."
        // US-1223: the sparkline's rising/falling cue was color-only. The row's
        // combined element overrides the child sparkline label, so fold the
        // 7-day trend direction in here where VoiceOver will actually speak it.
        let trend = row.viewTrend7d
        if trend.count >= 2 {
            let first = trend.first?.views ?? 0
            let last = trend.last?.views ?? 0
            label += " 7-day view trend \(trendDirection(first: first, last: last))."
        }
        return label
    }
}
