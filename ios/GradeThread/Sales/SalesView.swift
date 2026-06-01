import SwiftUI

/// Read-only Sales tab: lists the user's sales with a net-proceeds total.
/// Replaces the old US-184 placeholder. Pull-to-refresh re-fetches.
struct SalesView: View {
    @State private var store = SalesStore()
    private let currency = CurrencyFormatter()

    var body: some View {
        content
            .navigationTitle("Sales")
            .task { await store.refresh() }
            .refreshable { await store.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ProgressView("Loading sales…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load sales", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.refresh() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .ready(let sales) where sales.isEmpty:
            ContentUnavailableView(
                "No sales yet",
                systemImage: "dollarsign.circle",
                description: Text("Sold items from your synced marketplaces show up here.")
            )

        case .ready(let sales):
            List {
                Section {
                    HStack {
                        Text("Net proceeds")
                        Spacer()
                        Text(currency.formatDisplay(store.totalNet))
                            .font(.headline)
                            .foregroundStyle(Color.brandNavy)
                    }
                }
                Section {
                    ForEach(sales) { sale in
                        SaleRow(sale: sale, currency: currency)
                    }
                } header: {
                    Text("\(sales.count) sale\(sales.count == 1 ? "" : "s")")
                }
            }
        }
    }
}

private struct SaleRow: View {
    let sale: RemoteSale
    let currency: CurrencyFormatter

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(sale.itemTitle ?? "Untitled item")
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            HStack(spacing: 6) {
                Text(sale.date, format: .dateTime.month().day().year())
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
                    Text("net \(currency.formatDisplay(sale.net))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
