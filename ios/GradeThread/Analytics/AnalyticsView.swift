import Charts
import SwiftData
import SwiftUI

/// Reseller analytics: grade distribution, top brands by profit, sell-through,
/// and inventory value by status — rendered with Swift Charts over the local
/// SwiftData mirror (same data source as the dashboard). Reduces via
/// ``AnalyticsRollup``. Pushed from the Home dashboard.
struct AnalyticsView: View {
    /// US-1128: threaded into the listing-performance surface so its reconnect
    /// prompt can jump to the Marketplaces tab. Optional for previews/tests.
    var router: AppRouter? = nil

    @Query(sort: \LocalInventoryItem.updatedAt, order: .forward)
    private var items: [LocalInventoryItem]
    @Query private var sales: [LocalSale]
    @Query private var sources: [LocalSource]

    @State private var range: AnalyticsRange = .days90

    // US-1026: pull-to-refresh fires a real sync; the engine dedupes concurrent
    // pulls, and a transient banner surfaces failures.
    @Environment(\.syncEngine) private var syncEngine
    @State private var refreshError: String?

    // US-1169: AI period narrative. Fired on demand (not on open) so it never
    // spends an AI action unless the seller asks for the summary.
    private let narrator: AnalyticsNarrating = AnalyticsNarrativeService()
    @State private var narrative: AnalyticsNarrative?
    @State private var isNarrating = false
    @State private var narrativeError: String?

    // US-677 sourcing budget (monthly). Loaded from AppPreferences on appear so
    // edits re-render the meter without a round-trip through UserDefaults reads.
    @State private var sourcingBudget: Double? = AppPreferences.sourcingBudget
    @State private var showingBudgetEditor = false
    @State private var budgetDraft = ""

    private let currency = CurrencyFormatter()

    // MARK: - Derived

    private var gradedCount: Int { AnalyticsRollup.gradedCount(items: items) }
    private var averageGrade: Double? { AnalyticsRollup.averageGrade(items: items) }
    private var gradeBuckets: [GradeBucket] { AnalyticsRollup.gradeDistribution(items: items) }
    private var statusValues: [StatusValue] { AnalyticsRollup.inventoryValueByStatus(items: items) }
    private var sellThrough: [SellThroughRow] { AnalyticsRollup.sellThroughByBrand(items: items) }

    private var brandProfits: [BrandProfit] {
        AnalyticsRollup.topBrandsByProfit(
            items: items, sales: sales, since: range.start(now: .now))
    }

    private var periodPnL: PeriodPnL {
        AnalyticsRollup.periodPnL(items: items, sales: sales, since: range.start(now: .now))
    }
    private var roiBuckets: [RoiBucket] {
        AnalyticsRollup.gradingRoiBuckets(items: items, sales: sales, since: range.start(now: .now))
    }

    // US-677: per-source ROI rollup (all-time spend, window-agnostic — a source's
    // payback is a lifetime question, not a trailing-window one).
    private var sourceROI: [SourceROIRow] {
        SourceROIRollup.bySource(items: items, sales: sales, sources: sources)
    }

    /// Start of the current calendar month — the sourcing-budget window.
    private var monthStart: Date {
        let cal = Calendar.current
        return cal.date(from: cal.dateComponents([.year, .month], from: .now)) ?? .now
    }

    private var budgetStatus: SourcingBudgetStatus? {
        guard let budget = sourcingBudget else { return nil }
        return SourceROIRollup.budgetStatus(items: items, budget: budget, since: monthStart)
    }

    var body: some View {
        Group {
            if items.isEmpty && sales.isEmpty {
                emptyState
            } else {
                content
            }
        }
        .navigationTitle("Analytics")
        .navigationBarTitleDisplayMode(.inline)
        .task { Telemetry.event("analytics_opened") }
        .refreshable { await refreshFromServer() }
        .overlay(alignment: .bottom) { refreshErrorBanner }
    }

    /// US-1026: pull-to-refresh awaits a real ``SyncEngine.sync()`` so the
    /// spinner reflects true completion; the engine's own `isPulling` guard
    /// dedupes a refresh that lands while a sync is already running, and the
    /// local `@Query` re-renders when the merge notifies SwiftData.
    private func refreshFromServer() async {
        guard let syncEngine else {
            // Engine not booted yet — fall back to the notification path so the
            // pull isn't a dead gesture.
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            return
        }
        if case let .failed(message) = await syncEngine.sync() {
            await MainActor.run { withAnimation { refreshError = message } }
        }
    }

    @ViewBuilder
    private var refreshErrorBanner: some View {
        if let refreshError {
            Text(refreshError)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.brandRed, in: Capsule())
                .padding(.bottom, 24)
                .shadow(radius: 6, y: 2)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: refreshError) {
                    try? await Task.sleep(nanoseconds: 3_500_000_000)
                    withAnimation { self.refreshError = nil }
                }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                gradeHeader
                rangeCard
                aiSummaryCard
                listingPerformanceCard
                periodPnLCard
                gradingRoiCard
                sourcingBudgetCard
                sourceROICard
                brandProfitCard
                sellThroughCard
                gradeDistributionCard
                inventoryValueCard
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .onAppear { sourcingBudget = AppPreferences.sourcingBudget }
        // US-1169: the narrative describes a specific window, so drop it when the
        // range changes rather than showing a stale summary.
        .onChange(of: range) { _, _ in narrative = nil; narrativeError = nil }
        .alert("Monthly sourcing budget", isPresented: $showingBudgetEditor) {
            TextField("Amount", text: $budgetDraft)
                .keyboardType(.decimalPad)
            Button("Save") {
                // US-1162: locale-aware parse (accepts comma decimals / grouping).
                // US-1196: treat <= 0 (or garbage → 0) as "no budget" so a zero
                // budget doesn't render "Over budget" against an empty bar.
                let parsed = CurrencyFormatter().parse(budgetDraft)
                AppPreferences.sourcingBudget = parsed.flatMap { $0 > 0 ? $0 : nil }
                sourcingBudget = AppPreferences.sourcingBudget
            }
            if sourcingBudget != nil {
                Button("Remove budget", role: .destructive) {
                    AppPreferences.sourcingBudget = nil
                    sourcingBudget = nil
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Track how much you've spent sourcing this month against a target.")
        }
    }

    // MARK: - Header

    private var gradeHeader: some View {
        HStack(spacing: 12) {
            statTile(title: "Graded", value: "\(gradedCount)", system: "checkmark.seal.fill")
            statTile(
                title: "Avg grade",
                value: averageGrade.map { String(format: "%.1f", $0) } ?? "—",
                system: "star.fill"
            )
        }
    }

    private func statTile(title: String, value: String, system: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: system).font(.caption).foregroundStyle(Color.brandNavy)
                Text(title).font(.caption).foregroundStyle(.secondary)
            }
            Text(value)
                .font(.title2.weight(.bold))
                .foregroundStyle(Color.brandNavy)
        }
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .padding(16)
        .cardStyle(.flush)
    }

    private var rangeCard: some View {
        Picker("Range", selection: $range) {
            ForEach(AnalyticsRange.allCases) { r in
                Text(r.label).tag(r)
            }
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Cards

    // US-1128: entry point to the per-listing eBay performance surface
    // (impressions / CTR / watchers), parity with the web listing-performance
    // dashboard. Aggregate sell-through lives below; this drills into per-listing.
    private var listingPerformanceCard: some View {
        NavigationLink {
            ListingPerformanceView(router: router)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Listing performance")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Views, watchers, impressions & CTR per eBay listing")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func card<Content: View>(
        _ title: String,
        subtitle: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                // US-654: card/section headers use the Outfit display face.
                Text(title).font(.brandHeadline)
                if let subtitle {
                    Text(subtitle).font(.brandCaption).foregroundStyle(.secondary)
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .cardStyle(.flush)
    }

    private func notEnough() -> some View {
        Text("Not enough data yet.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
    }

    private func categoryHeight(_ count: Int) -> CGFloat {
        CGFloat(max(count, 1)) * 34 + 24
    }

    // US-1169: plain-language "what this means / what to do next" over the same
    // rollups the charts already render. On-demand so it never spends an AI
    // action on open.
    private var aiSummaryCard: some View {
        card("AI summary", subtitle: "What this period means · past \(range.label.lowercased())") {
            VStack(alignment: .leading, spacing: 10) {
                if let narrative {
                    Text(narrative.summary).font(.subheadline)
                    if !narrative.highlights.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(narrative.highlights, id: \.self) { line in
                                Text("•  \(line)").font(.caption)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    if !narrative.actions.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Next steps").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            ForEach(narrative.actions, id: \.self) { line in
                                Label(line, systemImage: "arrow.right")
                                    .font(.caption)
                            }
                        }
                    }
                    Button("Regenerate") { Task { await runNarrative() } }
                        .font(.caption).disabled(isNarrating)
                } else if isNarrating {
                    HStack(spacing: 8) { ProgressView(); Text("Summarizing…").font(.subheadline).foregroundStyle(.secondary) }
                } else {
                    Text("Get a plain-language read on this period's profit, ROI and sell-through.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button {
                        Task { await runNarrative() }
                    } label: {
                        Label("Summarize with AI", systemImage: "sparkles")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
                }
                if let narrativeError {
                    Text(narrativeError).font(.caption).foregroundStyle(Color.brandRed)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// US-1169: blended sell-through across brands that reached market.
    private var blendedSellThrough: Double? {
        let listed = sellThrough.reduce(0) { $0 + $1.listed }
        guard listed > 0 else { return nil }
        let sold = sellThrough.reduce(0) { $0 + $1.sold }
        return Double(sold) / Double(listed)
    }

    /// US-1169: average grading net-profit lift across bands where both sides exist.
    private var averageGradingLift: Double? {
        let lifts = roiBuckets.compactMap(\.netProfitLift)
        guard !lifts.isEmpty else { return nil }
        return lifts.reduce(0, +) / Double(lifts.count)
    }

    private func buildNarrativePayload() -> AnalyticsRollupPayload {
        let pnl = periodPnL
        return AnalyticsRollupPayload(
            periodLabel: "past \(range.label.lowercased())",
            grossRevenue: pnl.grossRevenue,
            fees: pnl.fees,
            cogs: pnl.cogs,
            unitsSold: pnl.unitsSold,
            sellThroughRate: blendedSellThrough,
            gradingRoiLift: averageGradingLift,
            topBrand: brandProfits.first?.brand,
            currency: AppPreferences.currencyCode ?? "USD"
        )
    }

    @MainActor
    private func runNarrative() async {
        isNarrating = true
        narrativeError = nil
        do {
            narrative = try await narrator.narrate(buildNarrativePayload())
        } catch {
            narrativeError = error.localizedDescription
        }
        isNarrating = false
    }

    // US-665: realized P&L for the window — revenue, COGS, gross profit.
    private var periodPnLCard: some View {
        let pnl = periodPnL
        return card("Profit & loss", subtitle: "\(pnl.unitsSold) sold · past \(range.label.lowercased())") {
            VStack(spacing: 8) {
                pnlRow("Gross revenue", pnl.grossRevenue)
                pnlRow("Platform fees", -pnl.fees)
                pnlRow("Cost of goods", -pnl.cogs)
                Divider()
                pnlRow("Gross profit", pnl.grossProfit, emphasized: true)
            }
        }
    }

    private func pnlRow(_ label: String, _ value: Double, emphasized: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(emphasized ? .subheadline.weight(.semibold) : .subheadline)
            Spacer()
            Text(currency.formatDisplay(value))
                // US-654: tabular figures use Inter with monospaced digits.
                .font(.brandData(15, weight: emphasized ? .bold : .regular))
                .foregroundStyle(value < 0 ? Color.brandRed : (emphasized ? Color.brandNavy : .primary))
        }
    }

    // US-665: grading ROI — graded vs ungraded net profit by price band.
    private var gradingRoiCard: some View {
        card("Grading ROI", subtitle: "Avg net profit: graded vs ungraded") {
            if roiBuckets.isEmpty {
                notEnough()
            } else {
                VStack(spacing: 10) {
                    ForEach(roiBuckets) { bucket in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(bucket.band).font(.subheadline.weight(.medium))
                                Spacer()
                                if let lift = bucket.netProfitLift {
                                    Text("\(lift >= 0 ? "+" : "")\(currency.formatDisplay(lift)) lift")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(lift >= 0 ? Color.brandEmerald : Color.brandRed)
                                }
                            }
                            HStack(spacing: 16) {
                                roiSide("Graded", bucket.gradedAvgNet, bucket.gradedCount)
                                roiSide("Ungraded", bucket.ungradedAvgNet, bucket.ungradedCount)
                            }
                            if !bucket.meaningful {
                                Text("Small sample — directional only.")
                                    .font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        }
    }

    private func roiSide(_ label: String, _ avg: Double?, _ count: Int) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(avg.map { currency.formatDisplay($0) } ?? "—")
                .font(.subheadline.weight(.semibold)).monospacedDigit()
            Text("\(count) sold").font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // Top brands by profit (window-filtered).
    private var brandProfitCard: some View {
        card("Top brands by profit", subtitle: "Net, past \(range.label.lowercased())") {
            if brandProfits.isEmpty {
                notEnough()
            } else {
                Chart(brandProfits) { row in
                    BarMark(
                        x: .value("Profit", row.netProfit),
                        y: .value("Brand", row.brand)
                    )
                    .foregroundStyle(row.netProfit < 0 ? Color.brandRed : Color.brandNavy)
                    .annotation(position: .trailing, alignment: .leading) {
                        Text(currency.formatDisplay(row.netProfit))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    // US-700: make each bar readable to VoiceOver.
                    .accessibilityLabel(row.brand)
                    .accessibilityValue("\(currency.formatDisplay(row.netProfit)) net profit")
                }
                .chartXAxis(.hidden)
                .frame(height: categoryHeight(brandProfits.count))
            }
        }
    }

    // Sell-through by brand (all inventory that reached market).
    private var sellThroughCard: some View {
        card("Sell-through by brand", subtitle: "Sold vs reached market") {
            if sellThrough.isEmpty {
                notEnough()
            } else {
                Chart(sellThrough) { row in
                    BarMark(
                        x: .value("Sell-through", row.rate),
                        y: .value("Brand", row.brand)
                    )
                    .foregroundStyle(Color.brandNavy)
                    .annotation(position: .trailing, alignment: .leading) {
                        Text("\(Int((row.rate * 100).rounded()))% · \(row.sold)/\(row.listed)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    // US-700
                    .accessibilityLabel(row.brand)
                    .accessibilityValue("\(Int((row.rate * 100).rounded())) percent sell-through, \(row.sold) of \(row.listed) sold")
                }
                .chartXScale(domain: 0.0...1.0)
                .chartXAxis(.hidden)
                .frame(height: categoryHeight(sellThrough.count))
            }
        }
    }

    // Grade tier distribution.
    private var gradeDistributionCard: some View {
        card("Grade distribution", subtitle: "Certified items by tier") {
            if gradeBuckets.isEmpty {
                notEnough()
            } else {
                Chart(gradeBuckets) { bucket in
                    BarMark(
                        x: .value("Tier", bucket.tier),
                        y: .value("Count", bucket.count)
                    )
                    .foregroundStyle(Color.brandNavy)
                    .annotation(position: .top) {
                        Text("\(bucket.count)").font(.caption2).foregroundStyle(.secondary)
                    }
                    // US-700
                    .accessibilityLabel("Tier \(bucket.tier)")
                    .accessibilityValue("\(bucket.count) items")
                }
                .frame(height: 180)
            }
        }
    }

    // On-hand inventory value by status.
    private var inventoryValueCard: some View {
        card("Inventory value by stage", subtitle: "Capital on hand") {
            if statusValues.isEmpty {
                notEnough()
            } else {
                Chart(statusValues) { row in
                    BarMark(
                        x: .value("Value", row.value),
                        y: .value("Stage", row.status.capitalized)
                    )
                    .foregroundStyle(Color.brandNavy)
                    .annotation(position: .trailing, alignment: .leading) {
                        Text(currency.formatDisplay(row.value))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    // US-700
                    .accessibilityLabel(row.status.capitalized)
                    .accessibilityValue("\(currency.formatDisplay(row.value)) on hand")
                }
                .chartXAxis(.hidden)
                .frame(height: categoryHeight(statusValues.count))
            }
        }
    }

    // US-677: monthly sourcing budget meter (spent vs target).
    private var sourcingBudgetCard: some View {
        card("Sourcing budget", subtitle: "Spent this month vs target") {
            if let status = budgetStatus {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(currency.formatDisplay(status.spent))
                            .font(.brandTitle2).monospacedDigit()
                            .foregroundStyle(status.isOver ? Color.brandRed : Color.brandNavy)
                        Text("of \(currency.formatDisplay(status.budget))")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                        Button("Edit") {
                            // US-1162: seed with the locale formatter so it round-trips.
                            budgetDraft = CurrencyFormatter().formatRaw(status.budget)
                            showingBudgetEditor = true
                        }
                        .font(.caption.weight(.semibold))
                    }
                    ProgressView(value: status.fraction)
                        .tint(status.isOver ? Color.brandRed : Color.brandNavy)
                    Text(status.isOver
                        ? "Over budget by \(currency.formatDisplay(-status.remaining))"
                        : "\(currency.formatDisplay(status.remaining)) remaining")
                        .font(.caption)
                        .foregroundStyle(status.isOver ? Color.brandRed : .secondary)
                }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Set a monthly target to track sourcing spend.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Set budget") {
                        budgetDraft = ""
                        showingBudgetEditor = true
                    }
                    .buttonStyle(.brandSecondary)
                }
            }
        }
    }

    // US-677: profit + sell-through grouped by acquisition source.
    private var sourceROICard: some View {
        card("Profit by source", subtitle: "ROI on what you've sourced") {
            if sourceROI.isEmpty {
                notEnough()
            } else {
                VStack(spacing: 10) {
                    ForEach(sourceROI.prefix(8)) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(row.sourceName).font(.subheadline.weight(.medium)).lineLimit(1)
                                Spacer()
                                Text(currency.formatDisplay(row.netProfit))
                                    .font(.subheadline.weight(.bold)).monospacedDigit()
                                    .foregroundStyle(row.netProfit < 0 ? Color.brandRed : Color.brandEmerald)
                            }
                            HStack(spacing: 12) {
                                Text("\(row.soldCount)/\(row.acquiredCount) sold")
                                Text("·")
                                Text("\(Int((row.sellThrough * 100).rounded()))% sell-through")
                                if let roi = row.roi {
                                    Text("·")
                                    Text("\(Int((roi * 100).rounded()))% ROI")
                                }
                            }
                            .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    // US-1198: note the rows hidden by the top-8 cap so a reseller
                    // with more sources knows the list is truncated.
                    if sourceROI.count > 8 {
                        Text("+\(sourceROI.count - 8) more source\(sourceROI.count - 8 == 1 ? "" : "s")")
                            .font(.caption2).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    // MARK: - Empty

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No analytics yet", systemImage: "chart.bar.xaxis")
        } description: {
            Text("Catalog items, grade them, and record sales — your trends will show up here.")
        }
    }
}
