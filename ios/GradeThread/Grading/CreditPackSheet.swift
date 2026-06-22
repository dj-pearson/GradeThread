import SwiftUI

/// Focused in-flow grade-credit purchase sheet (US-809), presented from the
/// grading flow's "not enough credits" banner. Reuses ``PaywallStore`` for the
/// StoreKit purchase path but shows ONLY the grade-credit consumables (no
/// plans), so the seller can top up without leaving the grading sheet
/// (Guideline 3.1.1 — buy at the point of need, no steering off-app). On a
/// successful purchase it dismisses and tells the caller, which then polls the
/// billing snapshot for the async grant (see ``CreditTopUpFlow``).
struct CreditPackSheet: View {
    @State private var store: PaywallStore
    @Environment(\.dismiss) private var dismiss
    /// Called once after a successful purchase (sheet already dismissing).
    let onPurchased: () -> Void

    init(userId: UUID, onPurchased: @escaping () -> Void) {
        _store = State(initialValue: PaywallStore(userId: userId))
        self.onPurchased = onPurchased
    }

    var body: some View {
        NavigationStack {
            List {
                switch store.phase {
                case .loading:
                    loadingRow
                case .failed(let message):
                    failed(message)
                case .ready:
                    creditsSection
                    restoreSection
                }
            }
            .navigationTitle("Buy grade credits")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
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
            // Ask to Buy / SCA deferral (US-1144): the purchase needs approval
            // before it completes, so `buy()` returns without an entitlement.
            // Tell the user instead of letting the sheet silently no-op (which
            // invites a confused re-tap → a second pending purchase).
            .alert("Purchase pending approval", isPresented: Binding(
                get: { store.purchasePending },
                set: { if !$0 { store.purchasePending = false } }
            )) {
                Button("OK", role: .cancel) { store.purchasePending = false }
            } message: {
                Text("Your purchase needs approval before it completes. Once it's approved, your credits are added automatically — no need to buy again.")
            }
            .task {
                if store.phase == .loading {
                    Telemetry.event("grade.credit_pack_opened")
                    await store.load()
                }
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
                Label("Couldn't load credit packs", systemImage: "creditcard.trianglebadge.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private var creditsSection: some View {
        Section {
            ForEach(IAPCatalog.consumables) { entry in
                creditRow(entry)
            }
        } header: {
            Text("Grade credits")
        } footer: {
            Text("You have \(store.creditBalance) credit\(store.creditBalance == 1 ? "" : "s"). Credits never expire and work alongside any plan.")
        }
    }

    private func creditRow(_ entry: IAPCatalogEntry) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).font(.body.weight(.semibold))
                Text(entry.blurb).font(.caption).foregroundStyle(.secondary)
                Label {
                    Text(entry.renewalDisclosure)
                } icon: {
                    Image(systemName: "creditcard")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if store.purchasingId == entry.productId {
                ProgressView()
            } else if !store.hasResolvedPrice(entry) {
                // StoreKit didn't return this pack — show "Unavailable" rather
                // than a tappable fallback price that dead-ends on tap (2.1(b)).
                Text("Unavailable")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
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
    }

    private var restoreSection: some View {
        Section {
            Button {
                Task { await store.restore(); HapticFeedback.light() }
            } label: {
                Label("Restore purchases", systemImage: "arrow.clockwise")
            }
        } footer: {
            Text("Bought credits on this Apple ID already? Restore to re-link them.")
        }
    }

    // MARK: - Actions

    private func buy(_ entry: IAPCatalogEntry) async {
        let ok = await store.buy(entry)
        if ok {
            HapticFeedback.success()
            Telemetry.event("grade.credit_pack_purchased", props: ["product": entry.productId])
            onPurchased()
            dismiss()
        } else if store.purchaseError != nil {
            HapticFeedback.error()
        }
    }
}
