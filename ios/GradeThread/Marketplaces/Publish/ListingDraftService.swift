import Foundation
import Supabase

/// Persists composer edits (title / condition / description) to the eBay
/// `listings` draft for an item, so the next publish picks them up. The edge
/// `assemblePublishContext` reads `listing.listing_title ?? item.title` etc.,
/// so these edits win at publish time.
///
/// Writes go through the user JWT client — RLS on `listings` scopes every
/// row to the caller via parent-item ownership (no service-role bypass).
@MainActor
struct ListingDraftService {
    private let supabase: SupabaseClient

    init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    private struct ListingIdRow: Decodable { let id: String }

    /// Thrown when the composer hands us a price we can't turn into a positive
    /// amount — so we never seed a $0 (or garbage) listing draft (US-789).
    enum ListingDraftError: LocalizedError {
        case invalidPrice(String)
        var errorDescription: String? {
            switch self {
            case .invalidPrice:
                return "Enter a valid price greater than $0 before publishing."
            }
        }
    }

    /// Parse a composer-supplied price string into a positive, cents-normalized
    /// amount, or throw. Uses the locale-tolerant currency parser (handles
    /// "$25", "24,99", and grouping separators), then rounds through ``Money``
    /// so the price sent to eBay carries no binary-float tail and rounds
    /// identically to the composer's profit estimate (US-1002). Rejects
    /// nil/zero/negative results — the guard that stops a $0 listing from being
    /// persisted (US-789). `formatter` is injectable so tests can pin a locale.
    nonisolated static func validatedListingPrice(
        _ priceValue: String,
        formatter: CurrencyFormatter = CurrencyFormatter()
    ) throws -> Double {
        guard let parsed = formatter.parse(priceValue) else {
            throw ListingDraftError.invalidPrice(priceValue)
        }
        let price = Money.cents(parsed)
        guard price > 0 else {
            throw ListingDraftError.invalidPrice(priceValue)
        }
        return price
    }

    /// Upserts the most-recent eBay listing draft for `inventoryItemId`.
    /// Updates it in place when one exists; otherwise inserts a fresh draft
    /// (`listing_price` is required + has no default, so we seed it from the
    /// validated price — by the time the composer is shown, validate has
    /// already guaranteed a price exists).
    func saveDraft(
        inventoryItemId: String,
        priceValue: String,
        edits: ComposerEdits
    ) async throws {
        // Reject anything that doesn't yield a positive amount before we touch
        // the DB. Previously `Double(priceValue) ?? 0` silently turned a
        // locale-formatted or garbage price into a $0 draft that could then be
        // published at $0 (US-789).
        let listingPrice = try Self.validatedListingPrice(priceValue)

        let existing: [ListingIdRow] = try await supabase
            .from("listings")
            .select("id")
            .eq("inventory_item_id", value: inventoryItemId)
            .eq("platform", value: "ebay")
            .order("created_at", ascending: false)
            .limit(1)
            .execute()
            .value

        let conditionDescription = edits.conditionDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let conditionDescriptionOrNil = conditionDescription.isEmpty ? nil : conditionDescription

        if let row = existing.first {
            struct Update: Encodable {
                let listing_title: String
                let listing_description: String
                let ebay_condition: String
                let ebay_condition_description: String?
            }
            try await supabase
                .from("listings")
                .update(Update(
                    listing_title: edits.title,
                    listing_description: edits.description,
                    ebay_condition: edits.condition.rawValue,
                    ebay_condition_description: conditionDescriptionOrNil
                ))
                .eq("id", value: row.id)
                .execute()
        } else {
            struct Insert: Encodable {
                let inventory_item_id: String
                let platform: String
                let listing_status: String
                let listing_price: Double
                let listing_title: String
                let listing_description: String
                let ebay_condition: String
                let ebay_condition_description: String?
            }
            try await supabase
                .from("listings")
                .insert(Insert(
                    inventory_item_id: inventoryItemId,
                    platform: "ebay",
                    listing_status: "draft",
                    listing_price: listingPrice,
                    listing_title: edits.title,
                    listing_description: edits.description,
                    ebay_condition: edits.condition.rawValue,
                    ebay_condition_description: conditionDescriptionOrNil
                ))
                .execute()
        }
    }

    /// US-816 — push a new price onto the item's most-recent eBay *draft*
    /// listing, if one exists, so a bulk price suggestion flows through to the
    /// pending listing. Returns true when a draft was found and updated. Only
    /// touches `draft` rows — an active/published listing reprices via eBay
    /// revise, never a direct write. RLS scopes the update to the caller.
    @discardableResult
    func updateDraftPrice(inventoryItemId: String, price: Double) async throws -> Bool {
        let existing: [ListingIdRow] = try await supabase
            .from("listings")
            .select("id")
            .eq("inventory_item_id", value: inventoryItemId)
            .eq("platform", value: "ebay")
            .eq("listing_status", value: "draft")
            .order("created_at", ascending: false)
            .limit(1)
            .execute()
            .value
        guard let row = existing.first else { return false }
        struct PriceUpdate: Encodable { let listing_price: Double }
        try await supabase
            .from("listings")
            .update(PriceUpdate(listing_price: price))
            .eq("id", value: row.id)
            .execute()
        return true
    }
}

/// The editable fields the composer collects before publishing.
struct ComposerEdits: Equatable {
    let title: String
    let condition: EbayCondition
    let conditionDescription: String
    let description: String
}
