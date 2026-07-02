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

    /// US-1517: the sale→item join maps. These were COMPUTED properties read
    /// per row inside the ForEach — a full dictionary build over the items
    /// table for every rendered sale row. Memoized on the same id+title
    /// signature MoneyView uses (US-967), rebuilt only when the item set (or a
    /// title) actually changes.
    private struct SaleJoins {
        let titlesByItemId: [String: String]
        let itemsById: [String: LocalInventoryItem]
    }
    @State private var joinsCache = SignatureCache<SaleJoins>()
    private var joins: SaleJoins {
        joinsCache.value(signature: MoneyView.titlesSignature(items)) {
            SaleJoins(
                titlesByItemId: Dictionary(
                    items.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a }
                ),
                itemsById: Dictionary(
                    items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }
                )
            )
        }
    }
    /// Gross PROCEEDS = sale price − marketplace fees. Deliberately NOT the
    /// unified net profit on the Money/Dashboard tabs (which nets out shipping,
    /// processing fees, seller costs, and cost basis via ``SalePnL``) — the
    /// Sales list is a quick per-order payout view, labeled "proceeds" so the
    /// same order is never shown as "net" with a different number elsewhere.
    private var totalProceeds: Double {
        Money.sum(sales) { $0.salePrice - $0.platformFees }
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
            } else if syncStatus.phase == .offline {
                // US-1195: a failed/blocked initial pull shouldn't masquerade as
                // a genuinely empty account — distinguish the offline case with a
                // retry hint instead of "No sales yet".
                ContentUnavailableView {
                    Label("You're offline", systemImage: "wifi.slash")
                } description: {
                    Text("Sales will appear once you reconnect. Pull down to retry.")
                }
            } else {
                ContentUnavailableView(
                    "No sales yet",
                    systemImage: "dollarsign.circle",
                    description: Text("Sold items from your synced marketplaces show up here.")
                )
            }
        } else {
            // US-1517: resolve the memoized joins ONCE per body pass — the
            // signature check itself is O(items), so per-row access would
            // reintroduce the quadratic cost this replaces.
            let joins = joins
            List {
                Section {
                    HStack {
                        Text("Proceeds (price − fees)")
                        Spacer()
                        Text(currency.formatDisplay(totalProceeds))
                            .font(.brandHeadline)
                            .foregroundStyle(Color.brandNavy)
                    }
                }
                Section {
                    ForEach(sales) { sale in
                        saleEntry(sale, joins: joins)
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
    private func saleEntry(_ sale: LocalSale, joins: SaleJoins) -> some View {
        let title = joins.titlesByItemId[sale.inventoryItemId] ?? "Untitled item"
        if let item = joins.itemsById[sale.inventoryItemId] {
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

    /// Gross proceeds (price − fees) — see ``SalesView`` for why this is not net.
    private var proceeds: Double { sale.salePrice - sale.platformFees }

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
                    Text("proceeds \(currency.formatDisplay(proceeds))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
