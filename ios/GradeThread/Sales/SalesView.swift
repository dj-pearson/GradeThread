import SwiftData
import SwiftUI

/// Sales tab. US-750: reads sales from the shared SwiftData cache (`LocalSale`)
/// like MoneyView/ItemCanvas do, instead of a separate `RemoteSale` fetch via
/// `SalesStore` that could drift from the numbers shown elsewhere. US-748: each
/// row links to its inventory item, so a sale is no longer a dead-end.
struct SalesView: View {
    @Query(sort: \LocalSale.saleDate, order: .reverse) private var sales: [LocalSale]
    @Query private var items: [LocalInventoryItem]
    // US-1163: distinguish "first sync still running" from "genuinely no sales"
    // so a fresh install doesn't read the empty state as a dead business.
    @Environment(SyncStatusStore.self) private var syncStatus
    private let currency = CurrencyFormatter()

    private var titlesByItemId: [String: String] {
        Dictionary(items.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
    }
    private var itemsById: [String: LocalInventoryItem] {
        Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }
    /// Net proceeds = sale price − marketplace fees, matching MoneyView.
    private var totalNet: Double {
        sales.reduce(0) { $0 + ($1.salePrice - $1.platformFees) }
    }

    var body: some View {
        content
            .navigationTitle("Sales")
            // Pull-to-refresh fires a full sync pull (same channel as Inventory
            // and Money) which re-populates the shared cache.
            .refreshable {
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            }
    }

    @ViewBuilder
    private var content: some View {
        if sales.isEmpty {
            if syncStatus.phase == .syncing {
                // First pull hasn't populated the cache yet — show a skeleton,
                // not the "no sales" empty state.
                ScrollView { SkeletonRows(count: 6).padding(.top) }
            } else {
                ContentUnavailableView(
                    "No sales yet",
                    systemImage: "dollarsign.circle",
                    description: Text("Sold items from your synced marketplaces show up here.")
                )
            }
        } else {
            List {
                Section {
                    HStack {
                        Text("Net proceeds")
                        Spacer()
                        Text(currency.formatDisplay(totalNet))
                            .font(.brandHeadline)
                            .foregroundStyle(Color.brandNavy)
                    }
                }
                Section {
                    ForEach(sales) { sale in
                        saleEntry(sale)
                    }
                } header: {
                    Text("\(sales.count) sale\(sales.count == 1 ? "" : "s")")
                }
            }
        }
    }

    /// US-748: a sale row links to its item when we have it cached locally,
    /// otherwise it renders non-navigating (orphan sale not yet synced).
    @ViewBuilder
    private func saleEntry(_ sale: LocalSale) -> some View {
        let title = titlesByItemId[sale.inventoryItemId] ?? "Untitled item"
        if let item = itemsById[sale.inventoryItemId] {
            NavigationLink {
                ItemCanvasView(item: item)
            } label: {
                SaleRow(title: title, sale: sale, currency: currency)
            }
        } else {
            SaleRow(title: title, sale: sale, currency: currency)
        }
    }
}

private struct SaleRow: View {
    let title: String
    let sale: LocalSale
    let currency: CurrencyFormatter

    private var net: Double { sale.salePrice - sale.platformFees }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            HStack(spacing: 6) {
                Text(sale.saleDate, format: .dateTime.month().day().year())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let buyer = sale.buyerUsername, !buyer.isEmpty {
                    Text("· \(buyer)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(currency.formatDisplay(sale.salePrice))
                        .font(.subheadline.weight(.semibold))
                    Text("net \(currency.formatDisplay(net))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
