import Charts
import GradeThreadCore
import SwiftData
import SwiftUI

/// The Money tab — the financial hub. This-month KPIs + a 6-month revenue
/// chart from the local cache, operating expenses (fetched + created
/// server-side), and a recent-sales preview that pushes the full list.
struct MoneyView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var expenseStore = ExpenseStore()
    /// US-2925: ONE sheet slot. These were two chained `.sheet(isPresented:)`
    /// modifiers, which is undefined in SwiftUI - the modifiers compete for the
    /// view's single slot and the loser opens and closes in the same frame. The
    /// enum also states the mutual exclusion that was always true: exporting
    /// financials and adding an expense are never both on screen.
    private enum MoneySheet: String, Identifiable {
        case export
        case addExpense
        var id: String { rawValue }
    }
    @State private var moneySheet: MoneySheet?
    // US-1498: surface a failed context-menu expense delete (was silently
    // discarded — a server rejection did nothing with no message).
    @State private var expenseActionError: String?

    @Query(sort: \LocalSale.saleDate, order: .reverse) private var sales: [LocalSale]
    @Query private var items: [LocalInventoryItem]
    // US-750: expenses now read from the SAME shared SwiftData cache as sales /
    // listings (populated by the sync engine), instead of ExpenseStore making a
    // separate RemoteExpense server fetch that could drift from the cache.
    @Query(sort: \LocalExpense.spentOn, order: .reverse) private var expenses: [LocalExpense]
    // US-812: acquisition sources back the ROI-by-source panel.
    @Query private var sources: [LocalSource]

    private let currency = CurrencyFormatter()

    // US-1517: the five analytics rollups + sold count, memoized. US-967 caught
    // titlesByItemId but missed these — every `body` pass (a refresh banner,
    // the export sheet toggling, an expense-store update) recomputed all five,
    // each allocating DateFormatters and making multiple full passes over the
    // sales table. Cached on a content signature; the accessors below cost one
    // cheap O(n) hash instead of the full rollup.
    private struct Derived {
        let metrics: MoneyMetrics
        let agingBrackets: [AgingBracket]
        let timeOnMarket: TimeOnMarketStats
        let cashFlow: [CashFlowMonth]
        let sourceROI: [SourceROIRow]
        let soldCount: Int
    }
    @State private var derivedCache = SignatureCache<Derived>()
    private var derived: Derived {
        let now = Date.now
        let signature = MoneyView.rollupSignature(
            items: items, sales: sales, expenses: expenses, sources: sources, now: now
        )
        return derivedCache.value(signature: signature) {
            Derived(
                metrics: MoneyRollup.compute(items: items, sales: sales, now: now),
                agingBrackets: MoneyAnalyticsRollup.inventoryAging(items: items, now: now),
                timeOnMarket: MoneyAnalyticsRollup.timeOnMarket(
                    items: items, sales: sales, now: now
                ),
                cashFlow: MoneyAnalyticsRollup.cashFlow(
                    items: items, sales: sales, expenses: expenses, now: now
                ),
                sourceROI: SourceROIRollup.bySource(items: items, sales: sales, sources: sources),
                soldCount: sales.lazy.filter { SalePnL.isCompleted($0) }.count
            )
        }
    }

    /// US-1517: content signature over everything the rollups read. Items ride
    /// on `updatedAt` (bumped by every local edit and the sync merge); sales and
    /// expenses have no updatedAt, so their rollup-relevant fields are hashed
    /// directly. The day bucket keeps day-granular figures ("this month",
    /// aging) from freezing if the tab sits open across midnight.
    static func rollupSignature(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        expenses: [LocalExpense],
        sources: [LocalSource],
        now: Date
    ) -> Int {
        var hasher = Hasher()
        hasher.combine(items.count)
        for item in items {
            hasher.combine(item.id)
            hasher.combine(item.updatedAt)
            hasher.combine(item.status)
        }
        hasher.combine(sales.count)
        for sale in sales {
            hasher.combine(sale.id)
            hasher.combine(sale.salePrice)
            hasher.combine(sale.platformFees)
            hasher.combine(sale.paymentProcessingFees)
            hasher.combine(sale.shippingCollected)
            hasher.combine(sale.shippingCost)
            hasher.combine(sale.gradingCost)
            hasher.combine(sale.otherCosts)
            hasher.combine(sale.tax)
            hasher.combine(sale.status)
            hasher.combine(sale.saleDate)
            hasher.combine(sale.inventoryItemId)
        }
        hasher.combine(expenses.count)
        for expense in expenses {
            hasher.combine(expense.id)
            hasher.combine(expense.amount)
            hasher.combine(expense.spentOn)
        }
        hasher.combine(sources.count)
        for source in sources {
            hasher.combine(source.id)
            hasher.combine(source.updatedAt)
        }
        hasher.combine(Int(now.timeIntervalSinceReferenceDate / 86_400))
        return hasher.finalize()
    }

    private var metrics: MoneyMetrics { derived.metrics }
    private var netProfit: Double {
        metrics.netProfitThisMonth - expensesThisMonthTotal()
    }

    // US-812: web `/finances`-parity analytics, all pure rollups over the local
    // cache so the Money tab matches the dashboard figure-for-figure.
    private var agingBrackets: [AgingBracket] { derived.agingBrackets }
    private var timeOnMarket: TimeOnMarketStats { derived.timeOnMarket }
    private var cashFlow: [CashFlowMonth] { derived.cashFlow }
    /// ROI grouped by acquisition source (all-time — a source's payback is a
    /// lifetime question). Reuses the rollup that powers the Analytics tab.
    private var sourceROI: [SourceROIRow] { derived.sourceROI }
    /// Count of completed sales — gates the per-item P&L navigation link.
    private var soldCount: Int { derived.soldCount }

    /// Sum of cached expenses dated in the current calendar month. Mirrors the
    /// old `ExpenseStore.thisMonthTotal` but reads the shared cache so the figure
    /// can't drift from the list shown below it.
    private func expensesThisMonthTotal(
        now: Date = .now,
        // US-1494: this is the total actually DISPLAYED (line "…this month" + the
        // net-profit calc). `spent_on` is parsed at UTC midnight, so bucket in UTC
        // too — Calendar.current put a boundary-day expense in the wrong month for
        // users behind/ahead of UTC. (The ExpenseStore.thisMonthTotal fix landed on
        // the older, cache-less helper; this is the live path.)
        calendar: Calendar = ExpenseStore.bucketingCalendar
    ) -> Double {
        guard let startOfMonth = calendar.date(
            from: calendar.dateComponents([.year, .month], from: now)
        ) else { return 0 }
        return Money.sum(expenses.filter { $0.spentOn >= startOfMonth }) { $0.amount }
    }

    /// US-967: id→title lookup for the sales preview, memoized in `@State` and
    /// rebuilt (via `.onChange` below) only when the item set or a title
    /// actually changes — not on every `body` pass (a refresh banner, an
    /// expense-store update, the export sheet toggling all re-evaluate `body`).
    @State private var titlesByItemId: [String: String] = [:]

    /// Cheap content signature gating the title-map rebuild: item count folded
    /// with each row's id + title.
    private var titlesSignature: Int { MoneyView.titlesSignature(items) }

    static func titlesSignature(_ items: [LocalInventoryItem]) -> Int {
        var hasher = Hasher()
        hasher.combine(items.count)
        for item in items {
            hasher.combine(item.id)
            hasher.combine(item.title)
        }
        return hasher.finalize()
    }

    static func buildTitlesByItemId(_ items: [LocalInventoryItem]) -> [String: String] {
        Dictionary(items.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
    }

    // US-812: chart helpers.

    /// Flatten one cash-flow month into the three plotted series (long format
    /// for grouped/positioned ``BarMark``s).
    static func cashFlowSeries(_ month: CashFlowMonth) -> [CashFlowSeriesPoint] {
        [
            CashFlowSeriesPoint(id: "\(month.id)-rev", kind: "Revenue", amount: month.revenue),
            CashFlowSeriesPoint(id: "\(month.id)-exp", kind: "Expenses", amount: month.expenses),
            CashFlowSeriesPoint(id: "\(month.id)-cogs", kind: "Cost basis", amount: month.costBasis),
        ]
    }

    /// Aging-bracket bar colour, keyed by label (mirrors the web palette:
    /// fresh → green, oldest → red).
    static func agingColor(_ label: String) -> Color {
        switch label {
        case "0-14 days": return .brandEmerald
        case "15-30 days": return .brandNavy
        case "31-60 days": return .brandAmber
        case "60+ days": return .brandRed
        default: return .brandNavy
        }
    }

    /// "12 days" / "1 day" / "—" for an average days figure.
    static func daysLabel(_ days: Double?) -> String {
        guard let days else { return "—" }
        let rounded = Int(days.rounded())
        return "\(rounded) day\(rounded == 1 ? "" : "s")"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                kpiRow
                // US-1871: the capital still on the racks, beside the money that
                // already came off them. Renders nothing when the feature is off
                // or the plan does not include it.
                InventoryEquityCard()
                if metrics.monthlyRevenue.contains(where: { $0.revenue > 0 }) {
                    revenueChart
                }
                // US-812: financial analytics parity with web /finances.
                cashFlowCard
                inventoryAgingCard
                timeOnMarketCard
                roiBySourceCard
                profitListCard
                fulfillmentCard
                repricingCard
                priceSuggestionsCard
                insightsCard
                reconciliationCard
                expensesCard
                salesCard
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Money")
        .toolbar {
            // US-664: date-ranged financial export.
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    moneySheet = .export
                } label: {
                    Image(systemName: "square.and.arrow.up")
                        .accessibilityLabel("Export financials")
                }
            }
        }
        .sheet(item: $moneySheet) { sheet in
            switch sheet {
            case .export: FinancialExportSheet()
            case .addExpense: ExpenseFormSheet(store: expenseStore)
            }
        }
        // US-1498: a failed context-menu expense delete now says so.
        .alert(
            "Couldn't delete the expense",
            isPresented: Binding(
                get: { expenseActionError != nil },
                set: { if !$0 { expenseActionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(expenseActionError ?? "")
        }
        // US-750: pull-to-refresh fires the same full sync pull as Inventory /
        // Sales, which repopulates the shared cache (sales + expenses). No
        // separate ExpenseStore.refresh — the @Query reflects the cache.
        .refreshable {
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
        // US-967: rebuild the id→title map only when the items (or a title)
        // change, not on every `body` re-evaluation.
        .onChange(of: titlesSignature, initial: true) { _, _ in
            titlesByItemId = MoneyView.buildTitlesByItemId(items)
        }
    }

    // MARK: - KPIs

    private var kpiRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("This month")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 0) {
                MoneyStatTile(
                    label: "Revenue",
                    value: currency.formatDisplay(metrics.revenueThisMonth),
                    tint: .brandNavy
                )
                Divider()
                MoneyStatTile(
                    label: "Net profit",
                    value: currency.formatDisplay(netProfit),
                    tint: netProfit < 0 ? .brandRed : .brandEmerald
                )
                Divider()
                MoneyStatTile(
                    label: "ROI",
                    value: metrics.roiThisMonth.map { "\(Int(($0 * 100).rounded()))%" } ?? "—",
                    tint: .brandNavy
                )
            }
            .padding(16)
            .cardStyle(.flush)
        }
    }

    // MARK: - Chart

    private var revenueChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Revenue · last 6 months")
                .font(.caption)
                .foregroundStyle(.secondary)
            Chart(metrics.monthlyRevenue) { month in
                BarMark(
                    x: .value("Month", month.label),
                    y: .value("Revenue", month.revenue)
                )
                .foregroundStyle(Color.brandNavy)
                // US-700: each month bar is readable to VoiceOver.
                .accessibilityLabel(month.label)
                .accessibilityValue(currency.formatDisplay(month.revenue))
            }
            .frame(height: 150)
        }
        .padding(16)
        .cardStyle(.flush)
    }

    // MARK: - Analytics panels (US-812)

    /// Shared titled-card chrome for the analytics panels.
    @ViewBuilder
    private func analyticsCard<Content: View>(
        _ title: String,
        subtitle: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .cardStyle(.flush)
    }

    private func analyticsEmpty(_ message: String) -> some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
    }

    /// Cash in vs out over the last 6 months — revenue against operating
    /// expenses + cost basis of goods sold.
    private var cashFlowCard: some View {
        let flow = cashFlow
        let hasData = flow.contains { $0.revenue > 0 || $0.expenses > 0 || $0.costBasis > 0 }
        return analyticsCard("Cash flow", subtitle: "Revenue vs expenses vs cost basis · 6 months") {
            if hasData {
                Chart {
                    ForEach(flow) { month in
                        ForEach(MoneyView.cashFlowSeries(month)) { point in
                            BarMark(
                                x: .value("Month", month.label),
                                y: .value("Amount", point.amount)
                            )
                            .position(by: .value("Kind", point.kind))
                            .foregroundStyle(by: .value("Kind", point.kind))
                            .accessibilityLabel("\(month.label) \(point.kind)")
                            .accessibilityValue(currency.formatDisplay(point.amount))
                        }
                    }
                }
                .chartForegroundStyleScale([
                    "Revenue": Color.brandEmerald,
                    "Expenses": Color.brandRed,
                    "Cost basis": Color.brandNavy,
                ])
                .chartLegend(position: .bottom, spacing: 8)
                .frame(height: 180)
            } else {
                analyticsEmpty("Record sales and expenses to see your cash flow.")
            }
        }
    }

    /// On-hand capital bucketed by how long it's been held.
    private var inventoryAgingCard: some View {
        let brackets = agingBrackets
        let hasData = brackets.contains { $0.count > 0 }
        return analyticsCard("Inventory aging", subtitle: "Cost basis tied up by age") {
            if hasData {
                Chart(brackets) { bracket in
                    BarMark(
                        x: .value("Age", bracket.label),
                        y: .value("Value", bracket.value)
                    )
                    .foregroundStyle(MoneyView.agingColor(bracket.label))
                    .annotation(position: .top) {
                        if bracket.count > 0 {
                            Text("\(bracket.count)")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityLabel(bracket.label)
                    .accessibilityValue("\(bracket.count) items, \(currency.formatDisplay(bracket.value)) tied up")
                }
                .frame(height: 170)
            } else {
                analyticsEmpty("No unsold inventory on hand.")
            }
        }
    }

    /// Days-to-sell average + distribution histogram.
    private var timeOnMarketCard: some View {
        let stats = timeOnMarket
        return analyticsCard(
            "Time on market",
            subtitle: stats.hasData
                ? "Avg \(MoneyView.daysLabel(stats.averageDays)) to sell · \(stats.soldCount) sold"
                : "How long items take to sell"
        ) {
            if stats.hasData {
                Chart(stats.distribution) { bucket in
                    BarMark(
                        x: .value("Days", bucket.label),
                        y: .value("Count", bucket.count)
                    )
                    .foregroundStyle(Color.brandNavy)
                    .annotation(position: .top) {
                        if bucket.count > 0 {
                            Text("\(bucket.count)")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityLabel(bucket.label)
                    .accessibilityValue("\(bucket.count) sold")
                }
                .frame(height: 170)
            } else {
                analyticsEmpty("Sold items will show how long they took to move.")
            }
        }
    }

    /// Net profit grouped by acquisition source (reuses ``SourceROIRollup``).
    private var roiBySourceCard: some View {
        let rows = Array(sourceROI.prefix(8))
        return analyticsCard("ROI by source", subtitle: "Realized net profit by where you sourced") {
            if rows.isEmpty {
                analyticsEmpty("Attribute items to a source to see ROI by source.")
            } else {
                Chart(rows) { row in
                    BarMark(
                        x: .value("Profit", row.netProfit),
                        y: .value("Source", row.sourceName)
                    )
                    .foregroundStyle(row.netProfit < 0 ? Color.brandRed : Color.brandNavy)
                    .annotation(position: .trailing, alignment: .leading) {
                        Text(row.roi.map { "\(Int(($0 * 100).rounded()))% ROI" } ?? currency.formatDisplay(row.netProfit))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .accessibilityLabel(row.sourceName)
                    .accessibilityValue(
                        "\(currency.formatDisplay(row.netProfit)) net profit"
                        + (row.roi.map { ", \(Int(($0 * 100).rounded())) percent ROI" } ?? "")
                    )
                }
                .chartXAxis(.hidden)
                .frame(height: CGFloat(rows.count) * 34 + 24)
                // US-1198: note sources hidden by the top-8 cap.
                if sourceROI.count > 8 {
                    Text("+\(sourceROI.count - 8) more source\(sourceROI.count - 8 == 1 ? "" : "s")")
                        .font(.caption2).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    /// Navigation into the per-item profit & loss list.
    private var profitListCard: some View {
        NavigationLink {
            MoneyProfitListView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "list.bullet.rectangle.portrait")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Profit by item")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(soldCount > 0
                        ? "Per-item sale price, fees, cost basis, profit and ROI"
                        : "Per-item P&L appears once items sell")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
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

    // MARK: - Expenses

    private var expensesCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Expenses", systemImage: "tray.and.arrow.down")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(currency.formatDisplay(expensesThisMonthTotal())) this month")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    moneySheet = .addExpense
                } label: {
                    Label("Add", systemImage: "plus")
                        .font(.caption.weight(.semibold))
                        .frame(minHeight: 44)  // US-1411: 44pt tap target
                }
                .buttonStyle(.bordered)
                .tint(Color.brandNavy)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            Divider().padding(.leading, 14)

            // US-750: read straight from the shared cache (instant + offline).
            if expenses.isEmpty {
                rowMessage {
                    Text("No expenses logged yet.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ForEach(Array(expenses.prefix(5))) { expense in
                    ExpenseRow(expense: expense, currency: currency)
                        .contextMenu {
                            Button(role: .destructive) {
                                Task {
                                    // US-1498: surface a rejection instead of
                                    // silently discarding the result.
                                    let result = await expenseStore.delete(
                                        id: expense.id, queueContext: modelContext)
                                    if case let .failed(message) = result {
                                        expenseActionError = message
                                    }
                                }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    Divider().padding(.leading, 14)
                }
            }
        }
        .cardStyle(.flush)
    }

    // MARK: - Shipping & fulfillment (US-669)

    private var fulfillmentCard: some View {
        NavigationLink {
            FulfillmentView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "shippingbox.circle.fill")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Shipping queue")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Orders sold but not yet shipped — mark shipped and add tracking")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
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

    // MARK: - Repricing

    private var repricingCard: some View {
        NavigationLink {
            RepricingView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "tag.circle.fill")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Repricing")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Condition-aware price suggestions for your active listings")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
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

    // MARK: - Price suggestions (US-816)

    private var priceSuggestionsCard: some View {
        NavigationLink {
            PriceSuggestionsView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "wand.and.stars")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Price suggestions")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Bulk eBay-comp prices for items with no price or stale listings")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
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

    // MARK: - Community insights (US-1064)

    private var insightsCard: some View {
        NavigationLink {
            CommunityInsightsView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "lightbulb.circle.fill")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Community insights")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("What to source and how to price, from anonymized community data")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
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

    // MARK: - Payout reconciliation (US-666)

    private var reconciliationCard: some View {
        NavigationLink {
            PayoutReconciliationView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "checklist.checked")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Payout reconciliation")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Match eBay payouts to your sales and fees")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
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

    // MARK: - Sales preview

    private var salesCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Sales", systemImage: "bag")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                NavigationLink {
                    SalesView()
                } label: {
                    Text("See all").font(.caption.weight(.semibold))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            Divider().padding(.leading, 14)

            if sales.isEmpty {
                rowMessage {
                    Text("Sold items show up here.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                // US-1194: net through SalePnL (the single source of truth) so
                // the preview matches Profit-by-item and the export, instead of
                // the partial `salePrice - platformFees`.
                let acquiredByItemId = Dictionary(
                    items.map { ($0.id, $0.acquiredPrice ?? 0) },
                    uniquingKeysWith: { a, _ in a }
                )
                ForEach(Array(sales.prefix(5))) { sale in
                    SalePreviewRow(
                        title: titlesByItemId[sale.inventoryItemId] ?? "Untitled item",
                        date: sale.saleDate,
                        price: sale.salePrice,
                        net: SalePnL.net(sale, costBasis: acquiredByItemId[sale.inventoryItemId] ?? 0),
                        currency: currency
                    )
                    Divider().padding(.leading, 14)
                }
            }
        }
        .cardStyle(.flush)
    }

    @ViewBuilder
    private func rowMessage<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack { content(); Spacer() }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
    }
}

// MARK: - Subviews

/// US-812: one plotted point in the cash-flow grouped bar chart.
struct CashFlowSeriesPoint: Identifiable, Equatable {
    let id: String
    let kind: String
    let amount: Double
}

private struct MoneyStatTile: View {
    let label: String
    let value: String
    let tint: Color

    var body: some View {
        VStack(spacing: 4) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value.isEmpty ? "—" : value)
                .font(.brandHeadline)
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct ExpenseRow: View {
    let expense: LocalExpense
    let currency: CurrencyFormatter

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: expense.categoryValue.systemImage)
                .font(.subheadline)
                .foregroundStyle(Color.brandNavy)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(expense.categoryValue.label)
                    .font(.subheadline)
                Text(expense.spentOn, format: .dateTime.month().day().year())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if expense.inventoryItemId != nil {
                // US-750: signal this cost is attributed to a specific item.
                Image(systemName: "link")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("Linked to an item")
            }
            Text("-\(currency.formatDisplay(expense.amount))")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

private struct SalePreviewRow: View {
    let title: String
    let date: Date
    let price: Double
    let net: Double
    let currency: CurrencyFormatter

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline).lineLimit(1)
                Text(date, format: .dateTime.month().day().year())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(currency.formatDisplay(price))
                    .font(.subheadline.weight(.semibold))
                Text("net \(currency.formatDisplay(net))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
