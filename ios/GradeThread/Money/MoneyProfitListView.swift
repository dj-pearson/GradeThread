import SwiftData
import SwiftUI

/// US-812 — per-item realized profit & loss, the iOS mirror of the web
/// `/finances` Profit/Loss-per-Item table. One row per completed sale (sale
/// price, fees, cost basis, net profit, ROI), sortable by profit / ROI /
/// recency. Pure math via ``MoneyAnalyticsRollup``; reachable from the Money tab.
struct MoneyProfitListView: View {
    @Query(sort: \LocalSale.saleDate, order: .reverse) private var sales: [LocalSale]
    @Query private var items: [LocalInventoryItem]

    @State private var sort: ItemProfitSort = .recent

    private let currency = CurrencyFormatter()

    /// Memoized rows + sort, rebuilt only when the underlying data or the sort
    /// changes (not on every `body` pass) — see US-967 pattern.
    @State private var rows: [ItemProfitRow] = []

    private var dataSignature: Int {
        var hasher = Hasher()
        hasher.combine(sort)
        hasher.combine(sales.count)
        hasher.combine(items.count)
        for sale in sales {
            hasher.combine(sale.id)
            hasher.combine(sale.salePrice)
            hasher.combine(sale.status)
        }
        return hasher.finalize()
    }

    private func rebuildRows() {
        let base = MoneyAnalyticsRollup.itemProfitRows(items: items, sales: sales)
        rows = MoneyAnalyticsRollup.sortProfitRows(base, by: sort)
    }

    var body: some View {
        Group {
            if rows.isEmpty {
                emptyState
            } else {
                content
            }
        }
        .navigationTitle("Profit by item")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Picker("Sort", selection: $sort) {
                    ForEach(ItemProfitSort.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.menu)
            }
        }
        .onChange(of: dataSignature, initial: true) { _, _ in rebuildRows() }
        .refreshable {
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
    }

    private var content: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(rows) { row in
                    ProfitRowView(row: row, currency: currency)
                    Divider().padding(.leading, 14)
                }
            }
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No sales yet", systemImage: "bag")
        } description: {
            Text("Once items sell, each sale's profit and ROI shows up here.")
        }
    }
}

// MARK: - Row

private struct ProfitRowView: View {
    let row: ItemProfitRow
    let currency: CurrencyFormatter

    private var profitColor: Color { row.netProfit < 0 ? .brandRed : .brandEmerald }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(currency.formatDisplay(row.netProfit))
                    .font(.subheadline.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(profitColor)
            }
            HStack(spacing: 10) {
                metric("Sale", currency.formatDisplay(row.revenue))
                metric("Fees", currency.formatDisplay(row.fees))
                metric("Cost", currency.formatDisplay(row.costBasis))
                metric("ROI", row.roi.map { "\(Int(($0 * 100).rounded()))%" } ?? "—")
            }
            Text(row.saleDate, format: .dateTime.month().day().year())
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        // US-700: collapse the row into one VoiceOver utterance.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.title)
        .accessibilityValue(
            "Net \(currency.formatDisplay(row.netProfit)), "
            + (row.roi.map { "\(Int(($0 * 100).rounded())) percent ROI" } ?? "no cost basis")
        )
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.caption.weight(.medium)).monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
