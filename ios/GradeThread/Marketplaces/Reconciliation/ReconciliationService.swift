import Foundation
import Supabase

/// supabase-swift wrapper for the orphan-listing reconciliation flow.
/// Three actions per orphan: Create (insert inventory_items + flip
/// matched), Link (point at an existing item + flip matched), Ignore
/// (flip ignored).
@MainActor
public final class ReconciliationService {

    private let supabase: SupabaseClient

    nonisolated public init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    // MARK: - Read

    /// Lightweight count of unmatched eBay listings — used by the shell-level
    /// Reconcile affordance (US-749) so the badge can surface on any tab without
    /// loading the full orphan list. Mirrors `fetchOrphans`'s filter.
    public func countOrphans(userId: String) async throws -> Int {
        struct Row: Decodable { let id: String }
        let rows: [Row] = try await supabase
            .from("flipdesk_ebay_listings")
            .select("id")
            .eq("user_id", value: userId)
            .eq("match_status", value: "unmatched")
            .execute()
            .value
        return rows.count
    }

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
            // US-751: mirror the live eBay listing into `listings` (best-effort)
            // so the new item's canvas immediately shows where it's listed — the
            // web reconciliation does this, iOS previously didn't, so a created
            // item showed 0 listings. A failure here must NOT strand the created
            // item, so it's swallowed; the next eBay sync also reconciles it.
            try? await upsertEbayListingRow(forItemId: newId, from: orphan)
            try await markMatched(orphanId: orphan.id, matchedItemId: newId)
            return ReconciliationOutcome(orphanId: orphan.id, kind: .created(itemId: newId))
        } catch {
            return ReconciliationOutcome(orphanId: orphan.id, kind: .failed(message: error.localizedDescription))
        }
    }

    /// Links an orphan to an existing inventory_items row. Mirrors the live eBay
    /// listing into `listings` (US-751) so the linked item's canvas shows it,
    /// then flips match_status + matched_item_id. A listing-mirror failure
    /// surfaces as `.failed` (the upsert is select-then-insert/update, so a retry
    /// can't duplicate the row).
    public func link(
        orphan: OrphanEbayListing,
        toExistingItemId itemId: String
    ) async -> ReconciliationOutcome {
        do {
            try await upsertEbayListingRow(forItemId: itemId, from: orphan)
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

    // MARK: - eBay listing mirror (US-751)

    /// The `listings`-row fields derived from an orphan eBay listing. Extracted as
    /// a pure mapping so the create/link mirror contract is unit-testable without
    /// Supabase. Mirrors the web's `upsertEbayListingRowForItem` (`listing_price`
    /// defaults to 0 when the orphan has no price; title/url pass through).
    public struct EbayListingMirrorFields: Equatable {
        public let platformListingId: String
        public let listingURL: String?
        public let listingPrice: Double
        public let listingTitle: String?
    }

    public static func ebayListingMirrorFields(
        from orphan: OrphanEbayListing
    ) -> EbayListingMirrorFields {
        EbayListingMirrorFields(
            platformListingId: orphan.ebayItemId,
            listingURL: orphan.listingURL,
            listingPrice: orphan.currentPrice ?? 0,
            listingTitle: orphan.title
        )
    }

    // MARK: - Private

    /// Mirrors a live eBay listing into the `listings` table for `itemId`, so the
    /// item canvas (which reads `listings`/`LocalListing`) shows where the item is
    /// listed after a reconcile. Idempotent: looks up an existing eBay listing
    /// for this item+ebay id and updates it, else inserts a fresh one — matching
    /// the web reconciliation (`upsertEbayListingRowForItem`). RLS scopes
    /// `listings` through the parent `inventory_items` row, which the caller has
    /// just created or owns, so no explicit user_id is needed (the table has none).
    private func upsertEbayListingRow(
        forItemId itemId: String,
        from orphan: OrphanEbayListing
    ) async throws {
        struct ExistingId: Decodable { let id: String }
        // Common, server-authoritative fields shared by insert + update. `listed_at`
        // is set ONLY on insert so an update never clobbers the original list date.
        struct Update: Encodable {
            let platform = "ebay"
            // US-1077: matching an imported live eBay listing → eBay-originated.
            let listing_origin = "ebay"
            let listing_url: String?
            let listing_price: Double
            let listing_title: String?
            let listing_status = "active"
            let is_active = true
        }
        struct Insert: Encodable {
            let inventory_item_id: String
            let platform = "ebay"
            let listing_origin = "ebay"
            let platform_listing_id: String
            let listing_url: String?
            let listing_price: Double
            let listing_title: String?
            let listing_status = "active"
            let is_active = true
            let listed_at: String
        }

        let fields = Self.ebayListingMirrorFields(from: orphan)
        let existing: [ExistingId] = try await supabase
            .from("listings")
            .select("id")
            .eq("inventory_item_id", value: itemId)
            .eq("platform", value: "ebay")
            .eq("platform_listing_id", value: fields.platformListingId)
            .limit(1)
            .execute()
            .value

        if let first = existing.first {
            try await supabase
                .from("listings")
                .update(Update(
                    listing_url: fields.listingURL,
                    listing_price: fields.listingPrice,
                    listing_title: fields.listingTitle
                ))
                .eq("id", value: first.id)
                .execute()
        } else {
            let listedAt = ISO8601DateFormatter().string(from: Date())
            try await supabase
                .from("listings")
                .insert(Insert(
                    inventory_item_id: itemId,
                    platform_listing_id: fields.platformListingId,
                    listing_url: fields.listingURL,
                    listing_price: fields.listingPrice,
                    listing_title: fields.listingTitle,
                    listed_at: listedAt
                ))
                .execute()
        }
    }

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
