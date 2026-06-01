import SwiftUI

/// Lists every unmatched eBay listing with swipe-action Create / Link /
/// Ignore + a top "Create all (N)" bulk button. Pushed from
/// MarketplacesView when the orphan count is > 0.
struct ReconciliationView: View {
    @Environment(AuthStore.self) private var authStore
    @State private var store = ReconciliationStore()
    @State private var creating: OrphanEbayListing?
    @State private var linking: OrphanEbayListing?
    @State private var bulkConfirming = false

    private let service = ReconciliationService()
    private let currencyFormatter = CurrencyFormatter()

    var body: some View {
        Group {
            switch store.phase {
            case .loading:
                loadingView
            case .ready(let orphans):
                if orphans.isEmpty {
                    emptyState
                } else {
                    listView(orphans: orphans)
                }
            case .failed(let message):
                failureView(message: message)
            }
        }
        .navigationTitle("Reconciliation")
        .navigationBarTitleDisplayMode(.large)
        .task {
            if let userId = currentUserId() {
                await store.refresh(userId: userId)
            }
        }
        .refreshable {
            if let userId = currentUserId() {
                await store.refresh(userId: userId)
            }
        }
        .sheet(item: $creating) { orphan in
            CreateItemFromListingSheet(
                orphan: orphan,
                service: service
            ) { outcome in
                Task { await applyOutcome(outcome) }
            }
        }
        .sheet(item: $linking) { orphan in
            LinkItemSheet(orphan: orphan, service: service) { outcome in
                Task { await applyOutcome(outcome) }
            }
        }
        .confirmationDialog(
            "Create \(store.count) item\(store.count == 1 ? "" : "s") from eBay?",
            isPresented: $bulkConfirming,
            titleVisibility: .visible
        ) {
            Button("Create all") {
                Task { await runCreateAll() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("We'll insert a new inventory item for each listing using the eBay title, SKU, and price. You can edit them afterwards.")
        }
        .alert(
            store.lastBulkResult?.summary ?? "",
            isPresented: Binding(
                get: { store.lastBulkResult != nil },
                set: { if !$0 { store.lastBulkResult = nil } }
            )
        ) {
            Button("OK") {}
        }
        .alert(
            store.lastActionError ?? "",
            isPresented: Binding(
                get: { store.lastActionError != nil },
                set: { if !$0 { store.lastActionError = nil } }
            )
        ) {
            Button("OK") {}
        }
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView().tint(Color.brandNavy)
            Text("Loading unmatched listings…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.green)
            Text("Nothing to reconcile")
                .font(.headline)
            Text("Every eBay listing is linked to an inventory item.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private func failureView(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(.red)
            Text("Couldn't load orphans")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private func listView(orphans: [OrphanEbayListing]) -> some View {
        VStack(spacing: 0) {
            bulkBar
            List {
                ForEach(orphans) { orphan in
                    OrphanRow(orphan: orphan, currencyFormatter: currencyFormatter)
                        // Leading swipe → Create. Matches the AC explicitly.
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button {
                                creating = orphan
                            } label: {
                                Label("Create item", systemImage: "plus.square")
                            }
                            .tint(Color.brandNavy)
                        }
                        // Trailing edge: Link (primary) + Ignore (destructive)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                Task { await runIgnore(orphan) }
                            } label: {
                                Label("Ignore", systemImage: "eye.slash")
                            }
                            Button {
                                linking = orphan
                            } label: {
                                Label("Link", systemImage: "link")
                            }
                            .tint(.blue)
                        }
                }
            }
            .listStyle(.plain)
        }
    }

    private var bulkBar: some View {
        HStack {
            Text("\(store.count) unmatched listing\(store.count == 1 ? "" : "s")")
                .font(.subheadline)
            Spacer()
            Button {
                AppRouter.haptic()
                bulkConfirming = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "square.and.arrow.down.on.square")
                    Text("Create all (\(store.count))")
                }
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(Capsule())
            }
            .disabled(store.isWorking)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground))
    }

    // MARK: - Actions

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }

    private func applyOutcome(_ outcome: ReconciliationOutcome) async {
        // The Create + Link sheets each return an outcome already
        // applied server-side. We just remove the row from the local
        // view if successful; failed outcomes stay so the user can
        // retry.
        guard outcome.isSuccess else { return }
        switch store.phase {
        case .ready(let orphans):
            store.phase = .ready(orphans: orphans.filter { $0.id != outcome.orphanId })
        default:
            break
        }
    }

    private func runIgnore(_ orphan: OrphanEbayListing) async {
        await store.runAction(on: orphan) { o in
            await service.ignore(orphan: o)
        }
    }

    private func runCreateAll() async {
        guard let userId = currentUserId() else { return }
        await store.runCreateAll(userId: userId, service: service)
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }
}

// MARK: - OrphanRow

private struct OrphanRow: View {
    let orphan: OrphanEbayListing
    let currencyFormatter: CurrencyFormatter

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(orphan.displayTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            HStack(spacing: 6) {
                if let sku = orphan.customLabel, !sku.isEmpty {
                    Text("SKU \(sku)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let price = orphan.currentPrice {
                    Text(currencyFormatter.formatDisplay(price))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.brandNavy)
                }
                Text("eBay #\(orphan.ebayItemId)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }
}
