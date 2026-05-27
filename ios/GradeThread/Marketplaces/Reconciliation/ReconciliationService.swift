import Foundation
import Supabase

/// supabase-swift wrapper for the orphan-listing reconciliation flow.
/// Three actions per orphan: Create (insert inventory_items + flip
/// matched), Link (point at an existing item + flip matched), Ignore
/// (flip ignored).
@MainActor
public final class ReconciliationService {

    private let supabase: SupabaseClient

    public init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    // MARK: - Read

    /// Fetches every unmatched eBay listing for the user, newest first.
    public func fetchOrphans(userId: String) async throws -> [OrphanEbayListing] {
        try await supabase
            .from("flipdesk_ebay_listings")
            .select("id, ebay_item_id, custom_label, title, current_price, available_quantity, listing_url, listing_format, imported_at")
            .eq("user_id", value: userId)
            .eq("match_status", value: "unmatched")
            .order("imported_at", ascending: false)
            .execute()
            .value
    }

    // MARK: - Mutations

    /// Inserts a new `inventory_items` row from the orphan's fields and
    /// flips the eBay row to matched + linked. The caller passes the
    /// user-edited title / SKU / target price so Create-sheet edits flow
    /// through; pass nil to fall back to the orphan defaults.
    public func createItem(
        from orphan: OrphanEbayListing,
        userId: String,
        title: String? = nil,
        sku: String? = nil,
        targetPrice: Double? = nil
    ) async -> ReconciliationOutcome {
        struct ItemInsert: Encodable {
            let user_id: String
            let title: String
            let sku: String?
            let target_price: Double?
            let status: String
            let item_category: String?
        }
        struct InsertedId: Decodable { let id: String }

        let finalTitle = (title?.trimmingCharacters(in: .whitespaces).nonEmpty
            ?? orphan.suggestedTitle)
        let finalSku = sku?.trimmingCharacters(in: .whitespaces).nonEmpty
            ?? orphan.customLabel?.trimmingCharacters(in: .whitespaces).nonEmpty
        let finalTarget = targetPrice ?? orphan.currentPrice

        do {
            let payload = ItemInsert(
                user_id: userId,
                title: finalTitle,
                sku: finalSku,
                target_price: finalTarget,
                // eBay says these are listed — start them in 'listed'
                // status so they show up correctly in the inventory list.
                status: "listed",
                item_category: nil
            )
            let inserted: [InsertedId] = try await supabase
                .from("inventory_items")
                .insert(payload, returning: .representation)
                .select("id")
                .execute()
                .value
            guard let newId = inserted.first?.id else {
                return ReconciliationOutcome(orphanId: orphan.id, kind: .failed(message: "Insert returned no id."))
            }
            try await markMatched(orphanId: orphan.id, matchedItemId: newId)
            return ReconciliationOutcome(orphanId: orphan.id, kind: .created(itemId: newId))
        } catch {
            return ReconciliationOutcome(orphanId: orphan.id, kind: .failed(message: error.localizedDescription))
        }
    }

    /// Links an orphan to an existing inventory_items row. No item
    /// creation; just flips match_status + matched_item_id.
    public func link(
        orphan: OrphanEbayListing,
        toExistingItemId itemId: String
    ) async -> ReconciliationOutcome {
        do {
            try await markMatched(orphanId: orphan.id, matchedItemId: itemId)
            return ReconciliationOutcome(orphanId: orphan.id, kind: .linked(itemId: itemId))
        } catch {
            return ReconciliationOutcome(orphanId: orphan.id, kind: .failed(message: error.localizedDescription))
        }
    }

    /// Marks an orphan as ignored — won't appear in the queue again
    /// until a re-sync overwrites it.
    public func ignore(orphan: OrphanEbayListing) async -> ReconciliationOutcome {
        struct Update: Encodable { let match_status: String }
        do {
            try await supabase
                .from("flipdesk_ebay_listings")
                .update(Update(match_status: "ignored"))
                .eq("id", value: orphan.id)
                .execute()
            return ReconciliationOutcome(orphanId: orphan.id, kind: .ignored)
        } catch {
            return ReconciliationOutcome(orphanId: orphan.id, kind: .failed(message: error.localizedDescription))
        }
    }

    /// Runs `createItem` for every orphan. Per-row failures are
    /// collected; one bad row doesn't stop the batch.
    public func createAll(
        _ orphans: [OrphanEbayListing],
        userId: String
    ) async -> ReconciliationBulkResult {
        var succeeded = 0
        var failures: [(String, String)] = []
        for orphan in orphans {
            let outcome = await createItem(from: orphan, userId: userId)
            switch outcome.kind {
            case .created:
                succeeded += 1
            case .failed(let message):
                failures.append((orphan.id, message))
            case .linked, .ignored:
                // Shouldn't happen from createItem but guard explicitly.
                break
            }
        }
        return ReconciliationBulkResult(succeeded: succeeded, failures: failures)
    }

    // MARK: - Private

    private func markMatched(orphanId: String, matchedItemId: String) async throws {
        struct Update: Encodable {
            let match_status: String
            let matched_item_id: String
        }
        try await supabase
            .from("flipdesk_ebay_listings")
            .update(Update(
                match_status: "matched",
                matched_item_id: matchedItemId
            ))
            .eq("id", value: orphanId)
            .execute()
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
