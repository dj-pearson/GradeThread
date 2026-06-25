import SwiftUI

/// Bulk price/quantity editor (US-1046 clean surface): select active eBay
/// listings, set price (absolute or reduce-by-%) and/or quantity, apply in one
/// bulk call.
struct BulkPricingView: View {
    @State private var store = BulkPricingStore()

    var body: some View {
        VStack(spacing: 0) {
            controls
            Divider()
            listingsList
        }
        .keyboardDoneToolbar()
        .navigationTitle("Bulk pricing")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load() }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.actionError != nil }, set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(store.actionError ?? "") }
        .overlay(alignment: .bottom) {
            if let banner = store.actionBanner {
                Text(banner)
                    .font(.footnote).padding(10)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 12)
                    .task {
                        try? await Task.sleep(nanoseconds: 2_500_000_000)
                        store.actionBanner = nil
                    }
            }
        }
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 10) {
            if store.hasMultipleAccounts, let name = store.primaryAccountName {
                // US-1216: bulk edits all push through the primary store's token
                // on the edge — name it so multi-store users don't unknowingly
                // mix accounts.
                Label(
                    "All updates apply to \(name) (your primary store). Change it in Marketplaces → eBay accounts.",
                    systemImage: "info.circle"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }

            Picker("Price", selection: $store.priceMode) {
                ForEach(BulkPricingStore.PriceMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            HStack(spacing: 10) {
                if store.priceMode == .set || store.priceMode == .reduce {
                    TextField(store.priceMode == .set ? "New price" : "% off", text: $store.priceText)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                }
                TextField("Set qty (optional)", text: $store.quantityText)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
            }

            if store.priceMode == .suggestFromComps {
                compsControls
            }

            Button {
                Task { await store.apply() }
            } label: {
                HStack {
                    if store.busy { ProgressView().controlSize(.small) }
                    Text("Apply to \(store.selected.count) selected")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!store.canApply)
        }
        .padding()
    }

    // MARK: - Suggest from comps (US-1167 AC2)

    private var compsControls: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                Task { await store.suggestFromComps() }
            } label: {
                HStack(spacing: 6) {
                    if store.fetchingComps {
                        ProgressView().controlSize(.small)
                        Text("Fetching comps \(store.compsDone)/\(store.compsTotal)…")
                    } else {
                        Image(systemName: "sparkles")
                        Text("Suggest prices from eBay comps")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(Color.brandNavy)
            .disabled(store.selected.isEmpty || store.fetchingComps)

            // AC3: be explicit these are ACTIVE asks, not sold prices, so the
            // user isn't misled into overpricing.
            Text("Uses the median of ACTIVE eBay asking prices for each title — a competitive starting point, not sold prices.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - List

    @ViewBuilder
    private var listingsList: some View {
        switch store.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            // US-971: in-place retry — a first-load failure here had no recovery
            // affordance (refreshable lives only on the ready list), a dead-end.
            ErrorStateView(
                title: "Couldn't load listings",
                message: message,
                retry: { await store.load() })
        case .ready:
            if store.listings.isEmpty {
                ContentUnavailableView("No active eBay listings", systemImage: "tag", description: Text("Listings with a live eBay offer will show up here."))
            } else {
                List {
                    Section {
                        Button(store.selected.count == store.listings.count ? "Clear all" : "Select all") {
                            store.toggleAll()
                        }
                        .font(.subheadline)
                    }
                    ForEach(store.listings) { listing in
                        row(listing)
                    }
                }
                .listStyle(.plain)
                .refreshable { await store.load() }
            }
        }
    }

    @ViewBuilder
    private func row(_ listing: BulkListing) -> some View {
        Button {
            store.toggle(listing.id)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: store.selected.contains(listing.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(store.selected.contains(listing.id) ? Color.brandNavy : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(listing.title).font(.subheadline).lineLimit(1)
                    if let err = store.rowErrors[listing.id] {
                        Text(err).font(.caption2).foregroundStyle(.red).lineLimit(1)
                    }
                }
                Spacer()
                Text(CurrencyFormatter().formatDisplay(listing.price))
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                // US-1167 (AC2): preview the comp-derived suggested price the
                // bulk apply will set for this row.
                if store.priceMode == .suggestFromComps,
                   let suggested = store.suggestedPrice(for: listing.id) {
                    Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.tertiary)
                    Text(CurrencyFormatter().formatDisplay(suggested))
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Color.brandNavy)
                }
                if let qty = listing.quantity {
                    Text("×\(qty)").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .tint(.primary)
    }
}
