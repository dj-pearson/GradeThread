import Foundation
import Supabase

/// Runs one ``BulkAction`` against a set of `LocalInventoryItem` rows.
///
/// Each action handler:
///   1. Validates the target items are in an appropriate state. Items
///      that fail the precondition end up in `failures` with a reason.
///   2. Updates the server via supabase-swift (one network call per
///      action, batched via `.in()` where possible).
///   3. Writes the same change optimistically to the local
///      `LocalInventoryItem` rows so the list reflects the new state
///      before the next sync pull catches up.
///   4. Returns a ``BulkActionResult`` the caller renders as a toast.
@MainActor
public struct BulkActionExecutor {

    private let supabase: SupabaseClient

    public init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    /// Routes to the per-action handler. Caller passes already-filtered
    /// items (the InventoryListView only includes rows visible in the
    /// current stage / search).
    /// `onProgress(done, total)` fires as a multi-item batch advances (US-644)
    /// so the caller can show "n of m". For single-call batches it fires once
    /// at completion.
    func execute(
        _ action: BulkAction,
        items: [LocalInventoryItem],
        onProgress: (@MainActor (Int, Int) -> Void)? = nil
    ) async -> BulkActionResult {
        switch action {
        case .createDraft:
            return await updateStatus(items, to: "drafted", action: action, onProgress: onProgress)
        case .publish:
            return await publishItems(items, action: action, onProgress: onProgress)
        case .markShipped:
            return await updateStatus(items, to: "shipped", action: action, onProgress: onProgress)
        case .endListing:
            return await endListings(items, action: action, onProgress: onProgress)
        case let .dropPrice(percent):
            return await dropPrices(items, percent: percent, action: action, onProgress: onProgress)
        case .aiEnrich:
            // US-791: no longer surfaced in any visible action set (see
            // BulkAction.actions). This stays as a defensive guard so an
            // accidental future routing degrades to a clear no-op result rather
            // than a crash — wire it up in the focused AI-batch pass.
            return notYetWired(action: action, items: items, reason: "AI enrich isn't available yet.")
        case .grade:
            // Grading is intercepted by InventoryListView and routed to its
            // own batch sheet, so this path is never taken in practice. Kept
            // for switch exhaustiveness with a clear no-op result.
            return notYetWired(action: action, items: items, reason: "Grading runs in its own batch flow.")
        case .exportCSV:
            // Export is a client-side bookkeeping action that doesn't
            // touch the server. Caller hands the items to a CSV writer
            // separately — we just return a success so the toast
            // confirms the count.
            return BulkActionResult(
                action: action,
                succeeded: items.count,
                failures: []
            )
        }
    }

    // MARK: - Single-item + undo (US-642 / US-644)

    /// Deletes one item server-side (US-642 swipe). The caller removes the
    /// local row from its `modelContext` on success. Returns nil on success or
    /// an error message on failure.
    func deleteItem(_ item: LocalInventoryItem) async -> String? {
        do {
            try await supabase
                .from("inventory_items")
                .delete()
                .eq("id", value: item.id)
                .execute()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Restores items to their prior status (US-644 undo) on the server +
    /// locally. Used to reverse a status-changing bulk action within the undo
    /// window.
    func revertStatuses(_ originals: [(item: LocalInventoryItem, status: String)]) async {
        struct StatusUpdate: Encodable { let status: String }
        for (item, status) in originals {
            try? await supabase
                .from("inventory_items")
                .update(StatusUpdate(status: status))
                .eq("id", value: item.id)
                .execute()
            item.status = status
            item.updatedAt = .now
        }
    }

    // MARK: - Handlers

    private func updateStatus(
        _ items: [LocalInventoryItem],
        to status: String,
        action: BulkAction,
        onProgress: (@MainActor (Int, Int) -> Void)? = nil
    ) async -> BulkActionResult {
        // Guard against regressing items already past the target status.
        // The web doesn't currently surface this either — keep parity by
        // letting the user re-affirm.
        let targetIds = items.map(\.id)
        do {
            struct StatusUpdate: Encodable { let status: String }
            try await supabase
                .from("inventory_items")
                .update(StatusUpdate(status: status))
                .in("id", values: targetIds)
                .execute()
            // Optimistic local apply.
            for item in items {
                item.status = status
                item.updatedAt = .now
            }
            onProgress?(items.count, items.count)
            return BulkActionResult(action: action, succeeded: items.count, failures: [])
        } catch {
            return BulkActionResult(
                action: action,
                succeeded: 0,
                failures: items.map {
                    .init(itemId: $0.id, message: error.localizedDescription)
                }
            )
        }
    }

    // MARK: - Bulk publish (US-680)

    /// Validates then pushes each selected item to eBay, one at a time, so a
    /// single blocked/failed item doesn't take the whole batch down. Items that
    /// aren't ready (missing category/specifics/price → validate blockers) are
    /// reported as per-item failures with the reason rather than pushed.
    private func publishItems(
        _ items: [LocalInventoryItem],
        action: BulkAction,
        onProgress: (@MainActor (Int, Int) -> Void)? = nil
    ) async -> BulkActionResult {
        let publish = EbayPublishService()
        var succeeded = 0
        var failures: [BulkActionResult.Failure] = []

        for (index, item) in items.enumerated() {
            defer { onProgress?(index + 1, items.count) }

            // 1) Pre-flight validate — surfaces eBay metadata blockers per item.
            switch await publish.validate(inventoryItemId: item.id) {
            case .validated(let response) where !response.blockers.isEmpty:
                failures.append(.init(itemId: item.id, message: response.blockers.joined(separator: "; ")))
                continue
            case .blockers(let blockers):
                failures.append(.init(itemId: item.id, message: blockers.joined(separator: "; ")))
                continue
            case .noOfferId:
                failures.append(.init(itemId: item.id, message: "No active eBay offer linked. Sync from Marketplaces, then try again."))
                continue
            case .failed(let message):
                failures.append(.init(itemId: item.id, message: message))
                continue
            case .validated:
                break  // ready — fall through to push
            case .pushed, .priceUpdated, .ended:
                failures.append(.init(itemId: item.id, message: "Unexpected response from server."))
                continue
            }

            // 2) Push.
            switch await publish.push(inventoryItemId: item.id) {
            case .pushed:
                succeeded += 1
                // Optimistic local apply, matching the single-item publish path.
                item.status = "listed"
                item.updatedAt = .now
            case .blockers(let blockers):
                failures.append(.init(itemId: item.id, message: blockers.joined(separator: "; ")))
            case .noOfferId:
                failures.append(.init(itemId: item.id, message: "No active eBay offer linked. Sync from Marketplaces, then try again."))
            case .failed(let message):
                failures.append(.init(itemId: item.id, message: message))
            case .validated, .priceUpdated, .ended:
                failures.append(.init(itemId: item.id, message: "Unexpected response from server."))
            }
        }
        return BulkActionResult(action: action, succeeded: succeeded, failures: failures)
    }

    // MARK: - eBay-backed handlers (US-185)

    /// Looks up the active eBay listing for each item, then DELETEs it
    /// via the edge service. Failures are aggregated per-item so a
    /// single broken listing doesn't take the whole batch down.
    private func endListings(
        _ items: [LocalInventoryItem],
        action: BulkAction,
        onProgress: (@MainActor (Int, Int) -> Void)? = nil
    ) async -> BulkActionResult {
        // US-645: a failed fetch must not read as "no active listing" for every
        // item — surface it as a batch-level network failure instead.
        let listings: [String: ActiveListing]
        do {
            listings = try await fetchActiveListings(itemIds: items.map(\.id))
        } catch {
            return Self.fetchFailureResult(action: action, items: items, error: error)
        }
        let publish = EbayPublishService()

        var succeeded = 0
        var failures: [BulkActionResult.Failure] = []

        for (index, item) in items.enumerated() {
            defer { onProgress?(index + 1, items.count) }
            guard let listing = listings[item.id] else {
                failures.append(.init(itemId: item.id, message: "No active eBay listing found."))
                continue
            }
            let outcome = await publish.endListing(listingId: listing.id)
            switch outcome {
            case .ended:
                succeeded += 1
                // Optimistic local apply — server moves status back to
                // drafted; mirror that locally so the list refilters.
                item.status = "drafted"
                item.updatedAt = .now
            case .noOfferId:
                failures.append(.init(itemId: item.id, message: "Listing isn't linked to an eBay offer."))
            case .failed(let message):
                failures.append(.init(itemId: item.id, message: message))
            case .validated, .pushed, .priceUpdated, .blockers:
                failures.append(.init(itemId: item.id, message: "Unexpected response from server."))
            }
        }
        return BulkActionResult(action: action, succeeded: succeeded, failures: failures)
    }

    /// Drops each item's active listing price by `percent`. Hard floor
    /// at $1 so the call doesn't push a nonsense number.
    private func dropPrices(
        _ items: [LocalInventoryItem],
        percent: Int,
        action: BulkAction,
        onProgress: (@MainActor (Int, Int) -> Void)? = nil
    ) async -> BulkActionResult {
        let listings: [String: ActiveListing]
        do {
            listings = try await fetchActiveListings(itemIds: items.map(\.id))
        } catch {
            return Self.fetchFailureResult(action: action, items: items, error: error)
        }
        let publish = EbayPublishService()

        var succeeded = 0
        var failures: [BulkActionResult.Failure] = []

        for (index, item) in items.enumerated() {
            defer { onProgress?(index + 1, items.count) }
            guard let listing = listings[item.id] else {
                failures.append(.init(itemId: item.id, message: "No active eBay listing found."))
                continue
            }
            let newPrice = Self.droppedPrice(from: listing.listing_price, percent: percent)
            let outcome = await publish.updatePrice(listingId: listing.id, price: newPrice)
            switch outcome {
            case .priceUpdated:
                succeeded += 1
                // Optimistic local apply so the grid shows the new price
                // before the next sync pull (the executor's contract; the
                // status handlers do the same).
                item.listingPrice = newPrice
                item.updatedAt = .now
            case .noOfferId:
                failures.append(.init(itemId: item.id, message: "Listing isn't linked to an eBay offer."))
            case .failed(let message):
                failures.append(.init(itemId: item.id, message: message))
            case .validated, .pushed, .ended, .blockers:
                failures.append(.init(itemId: item.id, message: "Unexpected response from server."))
            }
        }
        return BulkActionResult(action: action, succeeded: succeeded, failures: failures)
    }

    /// Reduces `current` by `percent`, rounds to whole cents, and floors at
    /// $1 so a price drop can never push a nonsense (zero/negative) number
    /// to eBay. Pure so the math is unit-testable without the network.
    static func droppedPrice(from current: Double, percent: Int) -> Double {
        let multiplier = max(0.01, 1.0 - Double(percent) / 100.0)
        return max(1.0, (current * multiplier * 100).rounded() / 100)
    }

    /// Batched fetch of the active eBay listing per item id. One query
    /// per batch — keyed by inventory_item_id so the caller can index
    /// directly. Items without an active eBay listing simply don't
    /// appear in the map.
    private struct ActiveListing: Decodable {
        let id: String
        let inventory_item_id: String
        let listing_price: Double
        let listing_status: String
        let platform: String
    }

    /// US-645: throws on a real fetch failure so callers can tell a network
    /// error apart from a genuinely-empty result (no active listings).
    private func fetchActiveListings(itemIds: [String]) async throws -> [String: ActiveListing] {
        guard !itemIds.isEmpty else { return [:] }
        let rows: [ActiveListing] = try await supabase
            .from("listings")
            .select("id, inventory_item_id, listing_price, listing_status, platform")
            .in("inventory_item_id", values: itemIds)
            .eq("platform", value: "ebay")
            .eq("listing_status", value: "active")
            .execute()
            .value
        // Deduplicate to the most recent per item — there could be multiple
        // historical listings; we only act on the active one.
        var map: [String: ActiveListing] = [:]
        for row in rows where map[row.inventory_item_id] == nil {
            map[row.inventory_item_id] = row
        }
        return map
    }

    /// Whole-batch failure when the active-listings lookup itself failed
    /// (US-645) — each item reports the network error, not a misleading
    /// "no active listing".
    private static func fetchFailureResult(
        action: BulkAction,
        items: [LocalInventoryItem],
        error: Error
    ) -> BulkActionResult {
        BulkActionResult(
            action: action,
            succeeded: 0,
            failures: items.map {
                .init(itemId: $0.id, message: "Couldn't load eBay listings: \(error.localizedDescription)")
            }
        )
    }

    private func notYetWired(
        action: BulkAction,
        items: [LocalInventoryItem],
        reason: String
    ) -> BulkActionResult {
        BulkActionResult(
            action: action,
            succeeded: 0,
            failures: items.map {
                .init(itemId: $0.id, message: reason)
            }
        )
    }
}
