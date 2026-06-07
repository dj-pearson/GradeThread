import SwiftUI

/// The shipping & fulfillment queue (US-669). Lists sold-but-unshipped orders
/// oldest-first with buyer + label cost, and lets the user mark each shipped
/// (with an optional tracking number) via a swipe action or a tap-through
/// sheet. Reachable as its own surface from the Money tab — not buried in the
/// flat sold-items list.
struct FulfillmentView: View {
    @State private var store = FulfillmentStore()
    @State private var shippingOrder: FulfillmentOrder?
    private let currency = CurrencyFormatter()

    var body: some View {
        content
            .navigationTitle("Shipping")
            .navigationBarTitleDisplayMode(.inline)
            .task { await store.load() }
            .refreshable { await store.load() }
            .sheet(item: $shippingOrder) { order in
                MarkShippedSheet(order: order, currency: currency) { tracking in
                    Task { await store.markShipped(order, trackingNumber: tracking) }
                }
                .presentationDetents([.medium])
            }
            .alert(
                "Couldn't mark as shipped",
                isPresented: Binding(
                    get: { store.actionError != nil },
                    set: { if !$0 { store.actionError = nil } }
                ),
                presenting: store.actionError
            ) { _ in
                Button("OK", role: .cancel) { store.actionError = nil }
            } message: { message in
                Text(message)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ScrollView { SkeletonRows(count: 6) }

        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load orders", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .ready where store.orders.isEmpty:
            ContentUnavailableView(
                "Nothing to ship",
                systemImage: "shippingbox",
                description: Text("Sold orders awaiting shipment show up here. You're all caught up.")
            )

        case .ready:
            queueList
        }
    }

    private var queueList: some View {
        List {
            Section {
                HStack {
                    Label("Awaiting shipment", systemImage: "shippingbox")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text("\(store.needsShippingCount)")
                        .font(.headline)
                        .foregroundStyle(Color.brandNavy)
                }
                if store.totalLabelCost > 0 {
                    HStack {
                        Text("Label cost")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(currency.formatDisplay(store.totalLabelCost))
                            .font(.subheadline.weight(.medium))
                    }
                }
            }

            Section {
                ForEach(store.orders) { order in
                    FulfillmentRow(order: order, currency: currency)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button {
                                shippingOrder = order
                            } label: {
                                Label("Mark shipped", systemImage: "checkmark.circle")
                            }
                            .tint(Color.brandNavy)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { shippingOrder = order }
                }
            } header: {
                Text("\(store.orders.count) order\(store.orders.count == 1 ? "" : "s") · oldest first")
            }
        }
    }
}

// MARK: - Row

private struct FulfillmentRow: View {
    let order: FulfillmentOrder
    let currency: CurrencyFormatter

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(order.itemTitle ?? "Untitled item")
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            HStack(spacing: 6) {
                Text(order.soldDate, format: .dateTime.month().day().year())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let buyer = order.buyerUsername, !buyer.isEmpty {
                    Text("· \(buyer)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(currency.formatDisplay(order.salePrice))
                        .font(.subheadline.weight(.semibold))
                    if order.shippingCost > 0 {
                        Text("label \(currency.formatDisplay(order.shippingCost))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Mark-shipped sheet

/// Confirms shipment for a single order, capturing an optional tracking
/// number. The number is free-form so the user can paste a carrier tracking
/// code from any provider.
private struct MarkShippedSheet: View {
    let order: FulfillmentOrder
    let currency: CurrencyFormatter
    /// Called with the entered (possibly empty) tracking number on confirm.
    let onConfirm: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var tracking: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Order") {
                    LabeledContent("Item", value: order.itemTitle ?? "Untitled item")
                    if let buyer = order.buyerUsername, !buyer.isEmpty {
                        LabeledContent("Buyer", value: buyer)
                    }
                    LabeledContent("Sale price", value: currency.formatDisplay(order.salePrice))
                    if order.shippingCost > 0 {
                        LabeledContent("Label cost", value: currency.formatDisplay(order.shippingCost))
                    }
                }
                Section {
                    TextField("Tracking number (optional)", text: $tracking)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("Tracking")
                } footer: {
                    Text("Paste the carrier tracking number if you have it. You can mark shipped without one.")
                }
            }
            .navigationTitle("Mark shipped")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Mark shipped") {
                        onConfirm(tracking)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }
}
