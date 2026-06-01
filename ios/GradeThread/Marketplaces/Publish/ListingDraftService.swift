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
                    listing_price: Double(priceValue) ?? 0,
                    listing_title: edits.title,
                    listing_description: edits.description,
                    ebay_condition: edits.condition.rawValue,
                    ebay_condition_description: conditionDescriptionOrNil
                ))
                .execute()
        }
    }
}

/// The editable fields the composer collects before publishing.
struct ComposerEdits: Equatable {
    let title: String
    let condition: EbayCondition
    let conditionDescription: String
    let description: String
}
