import SwiftUI

/// In-app paywall: subscription tiers (monthly/yearly) + credit packs, purchased
/// via StoreKit. Reuses `PaywallStore`. When an active Stripe subscription owns
/// the plan, subscription purchases are blocked with a "manage on web" note
/// (credit packs remain available).
struct PaywallView: View {
    @State private var store: PaywallStore
    @Environment(\.dismiss) private var dismiss

    init(userId: UUID) {
        _store = State(initialValue: PaywallStore(userId: userId))
    }

    var body: some View {
        List {
            switch store.phase {
            case .loading:
                loadingRow
            case .failed(let message):
                failed(message)
            case .ready:
                if store.managedOnWeb { managedBanner }
                intervalSection
                plansSection
                creditsSection
                restoreSection
            }
        }
        .navigationTitle("Plans")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .alert("Purchase failed", isPresented: Binding(
            get: { store.purchaseError != nil },
            set: { if !$0 { store.purchaseError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.purchaseError ?? "")
        }
        .task {
            if store.phase == .loading {
                Telemetry.event("paywall_opened")
                await store.load()
            }
        }
    }

    // MARK: - States

    private var loadingRow: some View {
        HStack { Spacer(); ProgressView(); Spacer() }
            .listRowBackground(Color.clear)
    }

    private func failed(_ message: String) -> some View {
        Section {
            ContentUnavailableView {
                Label("Couldn't load plans", systemImage: "creditcard.trianglebadge.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private var managedBanner: some View {
        Section {
            Label {
                Text("Your subscription is billed on the web. Manage or change it at gradethread.com — credit packs are still available below.")
                    .font(.footnote)
            } icon: {
                Image(systemName: "globe").foregroundStyle(Color.brandNavy)
            }
        }
    }

    // MARK: - Interval

    private var intervalSection: some View {
        Section {
            Picker("Billing", selection: Binding(
                get: { store.interval },
                set: { store.interval = $0 }
            )) {
                Text("Monthly").tag("monthly")
                Text("Yearly").tag("yearly")
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: - Plans

    private var plansSection: some View {
        Section("Plans") {
            ForEach(IAPCatalog.subscriptions(interval: store.interval)) { entry in
                productRow(entry)
            }
        }
    }

    private var creditsSection: some View {
        Section {
            ForEach(IAPCatalog.consumables) { entry in
                productRow(entry)
            }
        } header: {
            Text("Grade credits")
        } footer: {
            Text("Credits never expire and work alongside any plan.")
        }
    }

    private func productRow(_ entry: IAPCatalogEntry) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).font(.body.weight(.semibold))
                Text(entry.blurb).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            trailing(for: entry)
        }
    }

    @ViewBuilder
    private func trailing(for entry: IAPCatalogEntry) -> some View {
        if case let .subscription(plan, _) = entry.kind, store.isCurrentPlan(plan) {
            Text("Current")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.brandEmerald)
        } else if store.purchasingId == entry.productId {
            ProgressView()
        } else {
            Button {
                Task { await buy(entry) }
            } label: {
                Text(store.price(for: entry))
                    .font(.callout.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(.brandNavy)
            .disabled(!store.canPurchase(entry))
        }
    }

    private var restoreSection: some View {
        Section {
            Button {
                Task { await store.restore(); HapticFeedback.light() }
            } label: {
                Label("Restore purchases", systemImage: "arrow.clockwise")
            }
        } footer: {
            Text("Already subscribed on this Apple ID? Restore to re-link it.")
        }
    }

    // MARK: - Actions

    private func buy(_ entry: IAPCatalogEntry) async {
        let ok = await store.buy(entry)
        if ok {
            HapticFeedback.success()
            Telemetry.event("paywall_purchased", props: ["product": entry.productId])
        } else if store.purchaseError != nil {
            HapticFeedback.error()
        }
    }
}
