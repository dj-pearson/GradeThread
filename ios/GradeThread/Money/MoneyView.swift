import Charts
import SwiftData
import SwiftUI

/// The Money tab — the financial hub. This-month KPIs + a 6-month revenue
/// chart from the local cache, operating expenses (fetched + created
/// server-side), and a recent-sales preview that pushes the full list.
struct MoneyView: View {
    @State private var expenseStore = ExpenseStore()
    @State private var showingAddExpense = false

    @Query(sort: \LocalSale.saleDate, order: .reverse) private var sales: [LocalSale]
    @Query private var items: [LocalInventoryItem]

    private let currency = CurrencyFormatter()

    private var metrics: MoneyMetrics {
        MoneyRollup.compute(items: items, sales: sales, now: .now)
    }
    private var netProfit: Double {
        metrics.grossProfitThisMonth - expenseStore.thisMonthTotal()
    }
    private var titlesByItemId: [String: String] {
        Dictionary(items.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                kpiRow
                if metrics.monthlyRevenue.contains(where: { $0.revenue > 0 }) {
                    revenueChart
                }
                repricingCard
                expensesCard
                salesCard
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Money")
        .task { await expenseStore.refresh() }
        .refreshable {
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            await expenseStore.refresh()
        }
        .sheet(isPresented: $showingAddExpense) {
            ExpenseFormSheet(store: expenseStore)
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
                    tint: netProfit < 0 ? .brandRed : .green
                )
                Divider()
                MoneyStatTile(
                    label: "ROI",
                    value: metrics.roiThisMonth.map { "\(Int(($0 * 100).rounded()))%" } ?? "—",
                    tint: .brandNavy
                )
            }
            .padding(14)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
            }
            .frame(height: 150)
        }
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: - Expenses

    private var expensesCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Expenses", systemImage: "tray.and.arrow.down")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(currency.formatDisplay(expenseStore.thisMonthTotal())) this month")
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

            switch expenseStore.phase {
            case .loading:
                // US-656: shimmer skeleton rows instead of a bare spinner.
                SkeletonRows(count: 3, showsLeadingBlock: false)
            case .failed(let message):
                rowMessage {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
            case .ready(let rows) where rows.isEmpty:
                rowMessage {
                    Text("No expenses logged yet.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            case .ready(let rows):
                ForEach(Array(rows.prefix(5))) { expense in
                    ExpenseRow(expense: expense, currency: currency)
                        .contextMenu {
                            Button(role: .destructive) {
                                Task { _ = await expenseStore.delete(expense) }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    Divider().padding(.leading, 14)
                }
            }
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
            .padding(14)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
                .font(.headline)
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct ExpenseRow: View {
    let expense: RemoteExpense
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
                Text(expense.date, format: .dateTime.month().day().year())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
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
