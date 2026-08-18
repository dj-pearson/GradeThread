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
            // Brief success confirmation so a mark-shipped action isn't silent.
            .overlay(alignment: .bottom) {
                if let banner = store.actionBanner {
                    Text(banner)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(Color.brandNavy, in: Capsule())
                        .padding(.bottom, 24)
                        .task(id: banner) {
                            try? await Task.sleep(nanoseconds: 2_500_000_000)
                            store.actionBanner = nil
                        }
                }
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
                        .font(.brandHeadline)
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
                    Button {
                        shippingOrder = order
                    } label: {
                        FulfillmentRow(order: order, currency: currency)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button {
                            shippingOrder = order
                        } label: {
                            Label("Mark shipped", systemImage: "checkmark.circle")
                        }
                        .tint(Color.brandNavy)
                    }
                    .accessibilityHint("Opens the ship sheet")
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
    // US-1178: warn before sending an obviously-malformed tracking number to eBay.
    @State private var showTrackingWarning = false

    /// Carrier tracking numbers are alphanumeric, ~8–40 chars. We don't try to
    /// validate per-carrier (too brittle) — just catch obvious typos/paste errors.
    private var trackingLooksValid: Bool {
        let t = tracking.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return true } // empty is allowed (ship without)
        return (8...40).contains(t.count)
            && t.allSatisfy { $0.isLetter || $0.isNumber }
    }

    private func confirmShipped() {
        onConfirm(tracking.trimmingCharacters(in: .whitespacesAndNewlines))
        dismiss()
    }

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
                        if trackingLooksValid { confirmShipped() }
                        else { showTrackingWarning = true }
                    }
                    .fontWeight(.semibold)
                }
            }
            .confirmationDialog(
                "That tracking number looks off",
                isPresented: $showTrackingWarning,
                titleVisibility: .visible
            ) {
                Button("Mark shipped anyway") { confirmShipped() }
                Button("Let me fix it", role: .cancel) {}
            } message: {
                Text("It should be ~8–40 letters/numbers. Double-check before it goes to eBay.")
            }
        }
    }
}
