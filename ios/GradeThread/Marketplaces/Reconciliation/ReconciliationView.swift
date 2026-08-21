import SwiftUI

/// Lists every unmatched eBay listing with swipe-action Create / Link /
/// Ignore + a top "Create all (N)" bulk button. Pushed from
/// MarketplacesView when the orphan count is > 0.
struct ReconciliationView: View {
    @Environment(AuthStore.self) private var authStore
    /// US-751: refresh the shared cache after a link/create so the item's canvas
    /// shows the now-mirrored listing (the merge lands the LocalListing row).
    @Environment(\.syncEngine) private var syncEngine
    @State private var store = ReconciliationStore()
    /// One optional driving ONE `.sheet(item:)`. A view has a single sheet
    /// slot, so two `.sheet` modifiers on it compete for that slot and the
    /// loser presents and is torn down in the same frame — see ``ToolModule``
    /// and `Scripts/check-chained-sheets.py`.
    @State private var sheet: ReconcileSheet?

    /// What to do with one unmatched eBay listing.
    private enum ReconcileSheet: Identifiable {
        /// Create a new inventory item from the listing.
        case create(OrphanEbayListing)
        /// Link the listing to an item that already exists.
        case link(OrphanEbayListing)

        var id: String {
            switch self {
            case .create(let orphan): return "create-\(orphan.id)"
            case .link(let orphan):   return "link-\(orphan.id)"
            }
        }
    }
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
        .sheet(item: $sheet) { presented in
            switch presented {
            case .create(let orphan):
                CreateItemFromListingSheet(
                    orphan: orphan,
                    service: service
                ) { outcome in
                    Task { await applyOutcome(outcome) }
                }
            case .link(let orphan):
                LinkItemSheet(orphan: orphan, service: service) { outcome in
                    Task { await applyOutcome(outcome) }
                }
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
        // US-1192: a single alert (was two on one view, where SwiftUI presents
        // only one and can silently drop the other). An action error takes
        // priority over a bulk-result summary; dismiss clears both.
        .alert(
            store.lastActionError ?? store.lastBulkResult?.summary ?? "",
            isPresented: Binding(
                get: { store.lastActionError != nil || store.lastBulkResult != nil },
                set: { if !$0 { store.lastActionError = nil; store.lastBulkResult = nil } }
            )
        ) {
            Button("OK") { store.lastActionError = nil; store.lastBulkResult = nil }
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
                .scaledIconFont(size: 44, weight: .light)  // US-1152: scale with Dynamic Type
                .foregroundStyle(.brandEmerald)
            Text("Nothing to reconcile")
                .font(.brandHeadline)
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
        // US-971: an explicit "Try again" so the user isn't forced to discover
        // pull-to-refresh. `store.refresh` flips the phase to `.loading`, which
        // swaps this view out for `loadingView` and clears the error on success.
        ErrorStateView(
            title: "Couldn't load orphans",
            message: message,
            retry: {
                if let userId = currentUserId() {
                    await store.refresh(userId: userId)
                }
            }
        )
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
                                sheet = .create(orphan)
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
                                sheet = .link(orphan)
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
        HStack(spacing: 10) {
            // US-1240: while a bulk Create-All runs, show per-item progress
            // instead of the static count + button so a large queue isn't an
            // opaque multi-second wait.
            if let progress = store.bulkProgress {
                ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
                    .tint(Color.brandNavy)
                    .frame(maxWidth: 120)
                Text("Creating \(progress.done) of \(progress.total)…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Spacer()
            } else {
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
        // The Create + Link sheets each return an outcome already applied
        // server-side (and they surface their own failures inline), so we only
        // see successes here. Failed outcomes never reach this path.
        guard outcome.isSuccess else { return }
        // 1. Optimistically drop the resolved orphan from the queue (AC2) — no
        //    full manual re-sync needed for the list to update.
        switch store.phase {
        case .ready(let orphans):
            store.phase = .ready(orphans: orphans.filter { $0.id != outcome.orphanId })
        default:
            break
        }
        // 2. Confirm the action worked (the row vanishing + a success haptic).
        HapticFeedback.success()
        // 3. Targeted cache refresh (AC1): pull the now-linked item + its mirrored
        //    listing into the shared SwiftData cache so the item's canvas shows
        //    the listing instead of a dead-end "0 listings". Prefer the awaitable
        //    engine; fall back to the notification channel if it isn't wired yet.
        if let syncEngine {
            await syncEngine.sync()
        } else {
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
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
