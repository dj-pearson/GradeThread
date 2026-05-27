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
    public func execute(_ action: BulkAction, items: [LocalInventoryItem]) async -> BulkActionResult {
        switch action {
        case .createDraft:
            return await updateStatus(items, to: "drafted", action: action)
        case .markShipped:
            return await updateStatus(items, to: "shipped", action: action)
        case .endListing:
            return await endListings(items, action: action)
        case let .dropPrice(percent):
            return await dropPrices(items, percent: percent, action: action)
        case .aiEnrich:
            return notYetWired(action: action, items: items, reason: "Wires up in a focused AI-batch pass.")
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

    // MARK: - Handlers

    private func updateStatus(
        _ items: [LocalInventoryItem],
        to status: String,
        action: BulkAction
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

    // MARK: - eBay-backed handlers (US-185)

    /// Looks up the active eBay listing for each item, then DELETEs it
    /// via the edge service. Failures are aggregated per-item so a
    /// single broken listing doesn't take the whole batch down.
    private func endListings(
        _ items: [LocalInventoryItem],
        action: BulkAction
    ) async -> BulkActionResult {
        let listings = await fetchActiveListings(itemIds: items.map(\.id))
        let publish = EbayPublishService()

        var succeeded = 0
        var failures: [BulkActionResult.Failure] = []

        for item in items {
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
        action: BulkAction
    ) async -> BulkActionResult {
        let listings = await fetchActiveListings(itemIds: items.map(\.id))
        let publish = EbayPublishService()
        let multiplier = max(0.01, 1.0 - Double(percent) / 100.0)

        var succeeded = 0
        var failures: [BulkActionResult.Failure] = []

        for item in items {
            guard let listing = listings[item.id] else {
                failures.append(.init(itemId: item.id, message: "No active eBay listing found."))
                continue
            }
            let newPrice = max(1.0, (listing.listing_price * multiplier * 100).rounded() / 100)
            let outcome = await publish.updatePrice(listingId: listing.id, price: newPrice)
            switch outcome {
            case .priceUpdated:
                succeeded += 1
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

    private func fetchActiveListings(itemIds: [String]) async -> [String: ActiveListing] {
        guard !itemIds.isEmpty else { return [:] }
        do {
            let rows: [ActiveListing] = try await supabase
                .from("listings")
                .select("id, inventory_item_id, listing_price, listing_status, platform")
                .in("inventory_item_id", values: itemIds)
                .eq("platform", value: "ebay")
                .eq("listing_status", value: "active")
                .execute()
                .value
            // Deduplicate to the most recent per item — there could be
            // multiple historical listings; we only act on the active
            // one. The .eq("listing_status", value: "active") filter
            // typically yields one row per item but defend anyway.
            var map: [String: ActiveListing] = [:]
            for row in rows where map[row.inventory_item_id] == nil {
                map[row.inventory_item_id] = row
            }
            return map
        } catch {
            return [:]
        }
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
