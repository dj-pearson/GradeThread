import Foundation
import Supabase

/// Thrown when a save is attempted on an eBay-originated listing. The server
/// also rejects this (US-1080); the client mirrors the rule (US-1086).
enum ListingProvenanceError: LocalizedError {
    case ebayOriginatedLocked(listingId: String)
    var errorDescription: String? {
        "This listing is eBay-originated and must be edited on eBay."
    }
}

/// Final edited values for one draft (US-675). Optional string fields are
/// cleared (set NULL) when nil. Policy ids round-trip (seeded from the server,
/// optionally overwritten by an "Apply template" bulk action) so saving never
/// clobbers an existing policy the grid doesn't show.
struct DraftEdit: Equatable {
    let id: String
    let title: String?
    let price: Double
    let condition: String?
    let quantity: Int
    let bestOffer: Bool
    let categoryId: String?
    let returnPolicyId: String?
    let shippingPolicyId: String?
    let paymentPolicyId: String?
    /// Provenance carried through from `DraftListing.listingOrigin` (US-1086).
    let listingOrigin: String?
}

/// Data layer for the AutoLister drafts library + bulk-edit (US-675). Reads and
/// writes the `listings` table directly through supabase-swift — RLS scopes
/// rows to the owner via the parent inventory item, the same path the web uses.
/// Behind a protocol so the stores are unit-testable with a fake.
protocol DraftsProviding {
    /// Unpublished AutoLister drafts (listings in `draft` with a `batch_id`).
    func fetchDrafts() async throws -> [DraftListing]
    /// Inventory-item titles by id, for the listing-title fallback.
    func fetchItemTitles(ids: [String]) async throws -> [String: String]
    /// Persist one draft's edited fields.
    func save(_ edit: DraftEdit) async throws
}

struct DraftsService: DraftsProviding {
    private static let columns =
        "id, inventory_item_id, listing_title, listing_price, ebay_condition, " +
        "quantity, best_offer_enabled, platform_category_id, return_policy_id, " +
        "shipping_policy_id, payment_policy_id, batch_id, price_is_estimated, " +
        "listing_origin, publish_error, created_at, " +
        // US-1897 (AC5): the persisted Listing Quality Score. Safe to read in
        // the main select — migration 00476 is APPLIED in prod (verified via
        // /health/ready), so unlike the web's deploy-race there is no window
        // where this 42703s. If that ever stops being true, split it into a
        // fail-soft second query the way autolister-drafts.tsx does: a missing
        // column here would take the whole drafts library down, not just the chips.
        "quality_score, quality_blocked"

    func fetchDrafts() async throws -> [DraftListing] {
        // RLS scopes SELECT to the caller via the parent item. We filter to
        // `draft` server-side; the AutoLister subset (batch_id != nil) is kept
        // client-side in the store, dodging the uncertain NOT-NULL filter API.
        let rows: [DraftListing] = try await SupabaseShared.client
            .from("listings")
            .select(Self.columns)
            .eq("listing_status", value: "draft")
            .order("created_at", ascending: false)
            .limit(500)
            .execute()
            .value
        return rows
    }

    func fetchItemTitles(ids: [String]) async throws -> [String: String] {
        guard !ids.isEmpty else { return [:] }
        struct Row: Decodable { let id: String; let title: String? }
        let rows: [Row] = try await SupabaseShared.client
            .from("inventory_items")
            .select("id, title")
            .in("id", values: ids)
            .execute()
            .value
        var map: [String: String] = [:]
        for r in rows where r.title != nil { map[r.id] = r.title }
        return map
    }

    func save(_ edit: DraftEdit) async throws {
        // Client mirrors the server's provenance guard (US-1080/US-1086):
        // eBay-owned fields on eBay-originated listings must not be overwritten.
        if edit.listingOrigin == "ebay" {
            throw ListingProvenanceError.ebayOriginatedLocked(listingId: edit.id)
        }
        // RLS scopes the UPDATE to the caller via the parent item.
        try await SupabaseShared.client
            .from("listings")
            .update(Update(edit))
            .eq("id", value: edit.id)
            .execute()
    }

    /// Update payload. A custom encoder writes explicit JSON `null` (not
    /// omission) for cleared optionals, so blanking a field actually clears the
    /// column — `encodeIfPresent` would leave the old value in place.
    private struct Update: Encodable {
        let listing_title: String?
        let listing_price: Double
        let ebay_condition: String?
        let quantity: Int
        let best_offer_enabled: Bool
        let platform_category_id: String?
        let return_policy_id: String?
        let shipping_policy_id: String?
        let payment_policy_id: String?
        // Editing a price commits it — it's no longer an AI estimate (mirrors web).
        let price_is_estimated: Bool

        init(_ e: DraftEdit) {
            listing_title = e.title
            listing_price = e.price
            ebay_condition = e.condition
            quantity = e.quantity
            best_offer_enabled = e.bestOffer
            platform_category_id = e.categoryId
            return_policy_id = e.returnPolicyId
            shipping_policy_id = e.shippingPolicyId
            payment_policy_id = e.paymentPolicyId
            price_is_estimated = false
        }

        enum CodingKeys: String, CodingKey {
            case listing_title, listing_price, ebay_condition, quantity
            case best_offer_enabled, platform_category_id, return_policy_id
            case shipping_policy_id, payment_policy_id, price_is_estimated
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(listing_title, forKey: .listing_title)
            try c.encode(listing_price, forKey: .listing_price)
            try c.encode(ebay_condition, forKey: .ebay_condition)
            try c.encode(quantity, forKey: .quantity)
            try c.encode(best_offer_enabled, forKey: .best_offer_enabled)
            try c.encode(platform_category_id, forKey: .platform_category_id)
            try c.encode(return_policy_id, forKey: .return_policy_id)
            try c.encode(shipping_policy_id, forKey: .shipping_policy_id)
            try c.encode(payment_policy_id, forKey: .payment_policy_id)
            try c.encode(price_is_estimated, forKey: .price_is_estimated)
        }
    }
}
