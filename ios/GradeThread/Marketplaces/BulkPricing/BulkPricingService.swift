import Foundation

/// One active eBay listing eligible for a bulk price/quantity edit.
struct BulkListing: Identifiable, Equatable {
    let id: String
    let title: String
    let price: Double
    let quantity: Int?
}

/// One update sent to the bulk endpoint. Encoded via EdgeAPI's convertToSnakeCase
/// encoder (listingId -> listing_id). nil price/quantity are omitted.
struct BulkPriceQtyUpdate: Encodable, Equatable {
    let listingId: String
    let price: Double?
    let quantity: Int?
}

struct BulkPriceQtyResult: Decodable, Equatable {
    let listingId: String
    let ok: Bool
    let error: String?
}

struct BulkPriceQtyResponse: Decodable {
    let results: [BulkPriceQtyResult]
    let succeeded: Int
    let total: Int
}

/// Data layer for bulk price/quantity (US-1046 clean surface). Reads `listings`
/// directly through supabase-swift (RLS scopes to the caller via inventory-item
/// ownership) and applies updates via the consolidated edge endpoint, which
/// pushes to eBay's bulk_update_price_quantity. Behind a protocol so the store
/// is testable.
protocol BulkPricingProviding {
    func listings() async throws -> [BulkListing]
    func apply(updates: [BulkPriceQtyUpdate]) async throws -> BulkPriceQtyResponse
}

struct BulkPricingService: BulkPricingProviding {
    /// Wire row from `listings`. Price/quantity decode leniently because
    /// PostgREST can serialize numeric columns as JSON numbers OR strings.
    private struct Row: Decodable {
        let id: String
        let title: String?
        let price: Double
        let quantity: Int?
        let offerId: String?

        private enum CodingKeys: String, CodingKey {
            case id
            case title = "listing_title"
            case price = "listing_price"
            case quantity
            case offerId = "platform_offer_id"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title)
            offerId = try c.decodeIfPresent(String.self, forKey: .offerId)
            if let d = try? c.decode(Double.self, forKey: .price) {
                price = d
            } else if let s = try? c.decode(String.self, forKey: .price), let d = Double(s) {
                price = d
            } else {
                price = 0
            }
            if let i = try? c.decodeIfPresent(Int.self, forKey: .quantity) {
                quantity = i
            } else if let s = try? c.decodeIfPresent(String.self, forKey: .quantity) {
                quantity = s.flatMap(Int.init)
            } else {
                quantity = nil
            }
        }
    }

    func listings() async throws -> [BulkListing] {
        let response = try await SupabaseShared.client
            .from("listings")
            .select("id, listing_title, listing_price, quantity, platform_offer_id")
            .eq("platform", value: "ebay")
            .eq("listing_status", value: "active")
            .order("listed_at", ascending: false)
            .limit(500)
            .execute()
        let rows = (try? JSONDecoder().decode([Row].self, from: response.data)) ?? []
        // Only offers can be bulk-updated; filter client-side to avoid an
        // is-not-null filter quirk.
        return rows.compactMap { row in
            guard let offer = row.offerId, !offer.isEmpty else { return nil }
            return BulkListing(
                id: row.id,
                title: (row.title?.isEmpty == false ? row.title! : "Untitled listing"),
                price: row.price,
                quantity: row.quantity
            )
        }
    }

    func apply(updates: [BulkPriceQtyUpdate]) async throws -> BulkPriceQtyResponse {
        struct Body: Encodable { let updates: [BulkPriceQtyUpdate] }
        return try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/listings/bulk-price-quantity",
            body: Body(updates: updates)
        )
    }
}
