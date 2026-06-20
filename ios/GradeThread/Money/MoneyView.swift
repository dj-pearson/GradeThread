import Charts
import SwiftData
import SwiftUI

/// The Money tab — the financial hub. This-month KPIs + a 6-month revenue
/// chart from the local cache, operating expenses (fetched + created
/// server-side), and a recent-sales preview that pushes the full list.
struct MoneyView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var expenseStore = ExpenseStore()
    @State private var showingAddExpense = false
    @State private var showingExport = false

    @Query(sort: \LocalSale.saleDate, order: .reverse) private var sales: [LocalSale]
    @Query private var items: [LocalInventoryItem]
    // US-750: expenses now read from the SAME shared SwiftData cache as sales /
    // listings (populated by the sync engine), instead of ExpenseStore making a
    // separate RemoteExpense server fetch that could drift from the cache.
    @Query(sort: \LocalExpense.spentOn, order: .reverse) private var expenses: [LocalExpense]

    private let currency = CurrencyFormatter()

    private var metrics: MoneyMetrics {
        MoneyRollup.compute(items: items, sales: sales, now: .now)
    }
    private var netProfit: Double {
        metrics.grossProfitThisMonth - expensesThisMonthTotal()
    }

    /// Sum of cached expenses dated in the current calendar month. Mirrors the
    /// old `ExpenseStore.thisMonthTotal` but reads the shared cache so the figure
    /// can't drift from the list shown below it.
    private func expensesThisMonthTotal(now: Date = .now, calendar: Calendar = .current) -> Double {
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                kpiRow
                if metrics.monthlyRevenue.contains(where: { $0.revenue > 0 }) {
                    revenueChart
                }
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
                    showingExport = true
                } label: {
                    Image(systemName: "square.and.arrow.up")
                        .accessibilityLabel("Export financials")
                }
            }
        }
        .sheet(isPresented: $showingExport) {
            FinancialExportSheet()
        }
        // US-750: pull-to-refresh fires the same full sync pull as Inventory /
        // Sales, which repopulates the shared cache (sales + expenses). No
        // separate ExpenseStore.refresh — the @Query reflects the cache.
        .refreshable {
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
        .sheet(isPresented: $showingAddExpense) {
            ExpenseFormSheet(store: expenseStore)
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
                    showingAddExpense = true
                } label: {
                    Label("Add", systemImage: "plus")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
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
                                Task { _ = await expenseStore.delete(id: expense.id, queueContext: modelContext) }
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
                ForEach(Array(sales.prefix(5))) { sale in
                    SalePreviewRow(
                        title: titlesByItemId[sale.inventoryItemId] ?? "Untitled item",
                        date: sale.saleDate,
                        price: sale.salePrice,
                        net: sale.salePrice - sale.platformFees,
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
