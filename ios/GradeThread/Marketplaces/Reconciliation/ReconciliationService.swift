import Foundation
import Supabase

/// supabase-swift wrapper for the orphan-listing reconciliation flow.
/// Three actions per orphan: Create (insert inventory_items + flip
/// matched), Link (point at an existing item + flip matched), Ignore
/// (flip ignored).
@MainActor
public final class ReconciliationService {

    private let supabase: SupabaseClient

    /// Cached writer for the `listed_at` timestamp. Allocating an
    /// `ISO8601DateFormatter` is expensive and an insert can happen per orphan
    /// in a batch, so we reuse one instead of building a fresh formatter per
    /// insert (US-1226, mirrors the US-1007 fix in `EbaySyncService`).
    /// `.withFractionalSeconds` so iOS-written timestamps match server writes.
    private static let isoWriter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated public init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    // MARK: - Read

    /// Lightweight count of unmatched eBay listings — used by the shell-level
    /// Reconcile affordance (US-749) so the badge can surface on any tab without
    /// loading the full orphan list. Mirrors `fetchOrphans`'s filter.
    public func countOrphans(userId: String) async throws -> Int {
        // US-1649: HEAD + exact count — the server returns just the count, not
        // every unmatched row (the old .select("id") downloaded the whole set
        // only to take rows.count, which scaled badly with orphan volume).
        let response = try await supabase
            .from("flipdesk_ebay_listings")
            .select("id", head: true, count: .exact)
            .eq("user_id", value: userId)
            .eq("match_status", value: "unmatched")
            .execute()
        return response.count ?? 0
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
            // US-1648: a client-generated id gives the row a stable identity, so
            // the write below is an idempotent UPSERT — a retry after a lost
            // response updates the SAME row instead of minting a duplicate
            // inventory item (matches the photo-first draft convention).
            let id: String
            let user_id: String
            let title: String
            let sku: String?
            let target_price: Double?
            let status: String
            let item_category: String?
        }

        let finalTitle = (title?.trimmingCharacters(in: .whitespaces).nonEmpty
            ?? orphan.suggestedTitle)
        let finalSku = sku?.trimmingCharacters(in: .whitespaces).nonEmpty
            ?? orphan.customLabel?.trimmingCharacters(in: .whitespaces).nonEmpty
        let finalTarget = targetPrice ?? orphan.currentPrice
        // Lowercased to match Postgres uuid text form (the app's convention).
        let newId = UUID().uuidString.lowercased()

        do {
            let payload = ItemInsert(
                id: newId,
                user_id: userId,
                title: finalTitle,
                sku: finalSku,
                target_price: finalTarget,
                // eBay says these are listed — start them in 'listed'
                // status so they show up correctly in the inventory list.
                status: "listed",
                item_category: nil
            )
            try await supabase
                .from("inventory_items")
                .upsert(payload)
                .execute()
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
    ///
    /// US-1509: refuses to attach a SECOND active eBay listing to an item that
    /// already has one under a different eBay item id — that's how duplicate
    /// active rows are born, which then feed the wrong-row bulk-action class.
    /// Re-linking the SAME listing id stays allowed (the mirror upsert is
    /// idempotent). On success the item's status advances to "listed",
    /// consistent with `createItem` (eBay says it's live).
    public func link(
        orphan: OrphanEbayListing,
        toExistingItemId itemId: String
    ) async -> ReconciliationOutcome {
        do {
            struct ActiveRow: Decodable { let platform_listing_id: String? }
            let active: [ActiveRow] = try await supabase
                .from("listings")
                .select("platform_listing_id")
                .eq("inventory_item_id", value: itemId)
                .eq("platform", value: "ebay")
                .eq("is_active", value: true)
                .execute()
                .value
            if active.contains(where: { $0.platform_listing_id != orphan.ebayItemId }) {
                return ReconciliationOutcome(
                    orphanId: orphan.id,
                    kind: .failed(message: "That item already has an active eBay listing. Link this listing to a different item, or end the item\u{2019}s existing listing first.")
                )
            }
            try await upsertEbayListingRow(forItemId: itemId, from: orphan)
            try await markMatched(orphanId: orphan.id, matchedItemId: itemId)
            // Best-effort like the US-751 mirror: a status-write blip must not
            // strand the completed link — the next eBay sync reconciles it too.
            try? await markItemListed(itemId: itemId)
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
            // US-1226: scope the update to the signed-in user as well as the row
            // id, for defense-in-depth parity with the US-268 explicit-scoping
            // convention (a stale/forged id alone never flips another tenant's row).
            let userId = try await currentUserId()
            try await supabase
                .from("flipdesk_ebay_listings")
                .update(Update(match_status: "ignored"))
                .eq("id", value: orphan.id)
                .eq("user_id", value: userId)
                .execute()
            return ReconciliationOutcome(orphanId: orphan.id, kind: .ignored)
        } catch {
            return ReconciliationOutcome(orphanId: orphan.id, kind: .failed(message: error.localizedDescription))
        }
    }

    /// Maximum number of orphans to create concurrently in `createAll`. Mirrors
    /// `DraftsLibraryStore.bulkSaveConcurrency` (US-1166): each create is an
    /// independent multi-row write (inventory_items insert + listing mirror +
    /// match flip) with no shared mutable state, so a small bounded fan-out turns
    /// the old multi-second-per-item serial march into overlapping round-trips
    /// without flooding the connection pool.
    static let bulkCreateConcurrency = 4

    /// Runs `createItem` for every orphan with bounded concurrency (US-1240).
    /// Per-row failures are collected (one bad row doesn't stop the batch), and
    /// `progress` is invoked on the main actor with `(done, total)` after each
    /// chunk resolves so the UI can surface incremental progress instead of a
    /// single opaque spinner.
    public func createAll(
        _ orphans: [OrphanEbayListing],
        userId: String,
        progress: (@MainActor (Int, Int) -> Void)? = nil
    ) async -> ReconciliationBulkResult {
        let total = orphans.count
        guard total > 0 else { return ReconciliationBulkResult(succeeded: 0, failures: []) }

        var succeeded = 0
        var failures: [(String, String)] = []
        var done = 0
        progress?(0, total)

        // US-1240: create in bounded-concurrency chunks instead of awaiting each
        // createItem serially. Each create is independent, so the chunked task
        // group is safe; results fold back here on the @MainActor service.
        for chunk in orphans.chunked(into: Self.bulkCreateConcurrency) {
            let results = await withTaskGroup(
                of: (orphanId: String, ok: Bool, message: String?).self
            ) { group -> [(orphanId: String, ok: Bool, message: String?)] in
                for orphan in chunk {
                    group.addTask {
                        let outcome = await self.createItem(from: orphan, userId: userId)
                        switch outcome.kind {
                        case .created:
                            return (orphan.id, true, nil)
                        case .failed(let message):
                            return (orphan.id, false, message)
                        case .linked, .ignored:
                            // createItem only ever returns .created/.failed; guard.
                            return (orphan.id, false, "Unexpected outcome.")
                        }
                    }
                }
                var acc: [(orphanId: String, ok: Bool, message: String?)] = []
                for await r in group { acc.append(r) }
                return acc
            }
            for r in results {
                done += 1
                if r.ok { succeeded += 1 } else { failures.append((r.orphanId, r.message ?? "Create failed.")) }
            }
            progress?(done, total)
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
            let listedAt = Self.isoWriter.string(from: Date())
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

    /// US-1509: advance a just-linked item to "listed", matching the status
    /// `createItem` starts created items in — eBay says the listing is live, so
    /// the item must not linger in a pre-list pipeline stage (where the canvas
    /// offers a publish CTA that would double-list it). RLS scopes the row to
    /// the signed-in user.
    private func markItemListed(itemId: String) async throws {
        struct Update: Encodable { let status = "listed" }
        try await supabase
            .from("inventory_items")
            .update(Update())
            .eq("id", value: itemId)
            .execute()
    }

    private func markMatched(orphanId: String, matchedItemId: String) async throws {
        struct Update: Encodable {
            let match_status: String
            let matched_item_id: String
        }
        // US-1226: scope to the signed-in user in addition to the row id, for
        // defense-in-depth parity with the US-268 explicit-scoping convention.
        let userId = try await currentUserId()
        try await supabase
            .from("flipdesk_ebay_listings")
            .update(Update(
                match_status: "matched",
                matched_item_id: matchedItemId
            ))
            .eq("id", value: orphanId)
            .eq("user_id", value: userId)
            .execute()
    }

    /// Resolves the signed-in user's id for tenant scoping (US-1226). Uses the
    /// same `auth.session` accessor as the other in-service flows
    /// (`TemplateService`, `ConsignorService`); throws if there's no session.
    private func currentUserId() async throws -> String {
        try await supabase.auth.session.user.id.uuidString
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

// US-1240: split a collection into fixed-size chunks for bounded-concurrency
// processing (mirrors the US-1166 helper in DraftsLibraryStore). private so it
// can't collide with a future shared helper.
private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        guard size > 0 else { return [self] }
        return stride(from: 0, to: count, by: size).map {
            Array(self[$0 ..< Swift.min($0 + size, count)])
        }
    }
}
