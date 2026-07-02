import Foundation

/// An unpublished AutoLister draft — a `listings` row in `draft` status that
/// carries a `batch_id` (US-675). Mirrors the web's DraftRow. Read via
/// supabase-swift directly (RLS scopes to the owner through the parent item),
/// so keys are declared explicitly snake_case (no EdgeAPI key conversion).
struct DraftListing: Identifiable, Decodable, Equatable {
    let id: String
    let inventoryItemId: String
    let listingTitle: String?
    let listingPrice: Double?
    let ebayCondition: String?
    let quantity: Int?
    let bestOfferEnabled: Bool?
    let platformCategoryId: String?
    let returnPolicyId: String?
    let shippingPolicyId: String?
    let paymentPolicyId: String?
    let batchId: String?
    let priceIsEstimated: Bool?
    let createdAt: String?
    /// Provenance marker (US-1086): `"gradethread"` | `"ebay"`. AutoLister drafts
    /// are always GradeThread-originated; the field is decoded for completeness.
    let listingOrigin: String?
    /// US-1511: last publish failure recorded on this draft (US-1079's
    /// `publish_error`, mapped to a short user-facing message server-side).
    /// A scheduled/AutoLister publish that failed lands back in `draft` status
    /// carrying this — without it the failure was invisible on iOS.
    let publishError: String?

    /// Parsed `created_at` for sorting/display; distantPast on miss. Handles
    /// ISO 8601 with or without fractional seconds (PostgREST emits both).
    var created: Date {
        guard let createdAt else { return .distantPast }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: createdAt) { return d }
        return ISO8601DateFormatter().date(from: createdAt) ?? .distantPast
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case inventoryItemId = "inventory_item_id"
        case listingTitle = "listing_title"
        case listingPrice = "listing_price"
        case ebayCondition = "ebay_condition"
        case quantity
        case bestOfferEnabled = "best_offer_enabled"
        case platformCategoryId = "platform_category_id"
        case returnPolicyId = "return_policy_id"
        case shippingPolicyId = "shipping_policy_id"
        case paymentPolicyId = "payment_policy_id"
        case batchId = "batch_id"
        case priceIsEstimated = "price_is_estimated"
        case createdAt = "created_at"
        case listingOrigin = "listing_origin"
        case publishError = "publish_error"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        inventoryItemId = try c.decode(String.self, forKey: .inventoryItemId)
        listingTitle = try c.decodeIfPresent(String.self, forKey: .listingTitle)
        // Decimal columns can arrive as a JSON number OR a numeric string.
        listingPrice = Self.lenientDouble(c, .listingPrice)
        ebayCondition = try c.decodeIfPresent(String.self, forKey: .ebayCondition)
        quantity = try c.decodeIfPresent(Int.self, forKey: .quantity)
        bestOfferEnabled = try c.decodeIfPresent(Bool.self, forKey: .bestOfferEnabled)
        platformCategoryId = try c.decodeIfPresent(String.self, forKey: .platformCategoryId)
        returnPolicyId = try c.decodeIfPresent(String.self, forKey: .returnPolicyId)
        shippingPolicyId = try c.decodeIfPresent(String.self, forKey: .shippingPolicyId)
        paymentPolicyId = try c.decodeIfPresent(String.self, forKey: .paymentPolicyId)
        batchId = try c.decodeIfPresent(String.self, forKey: .batchId)
        priceIsEstimated = try c.decodeIfPresent(Bool.self, forKey: .priceIsEstimated)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        listingOrigin = try c.decodeIfPresent(String.self, forKey: .listingOrigin)
        publishError = try c.decodeIfPresent(String.self, forKey: .publishError)
    }

    /// Memberwise initializer for tests/previews.
    init(
        id: String,
        inventoryItemId: String,
        listingTitle: String? = nil,
        listingPrice: Double? = nil,
        ebayCondition: String? = nil,
        quantity: Int? = nil,
        bestOfferEnabled: Bool? = nil,
        platformCategoryId: String? = nil,
        returnPolicyId: String? = nil,
        shippingPolicyId: String? = nil,
        paymentPolicyId: String? = nil,
        batchId: String? = nil,
        priceIsEstimated: Bool? = nil,
        createdAt: String? = nil,
        listingOrigin: String? = nil,
        publishError: String? = nil
    ) {
        self.id = id
        self.inventoryItemId = inventoryItemId
        self.listingTitle = listingTitle
        self.listingPrice = listingPrice
        self.ebayCondition = ebayCondition
        self.quantity = quantity
        self.bestOfferEnabled = bestOfferEnabled
        self.platformCategoryId = platformCategoryId
        self.returnPolicyId = returnPolicyId
        self.shippingPolicyId = shippingPolicyId
        self.paymentPolicyId = paymentPolicyId
        self.batchId = batchId
        self.priceIsEstimated = priceIsEstimated
        self.createdAt = createdAt
        self.listingOrigin = listingOrigin
        self.publishError = publishError
    }

    private static func lenientDouble(
        _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys
    ) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return d }
        if let s = try? c.decodeIfPresent(String.self, forKey: key) { return Double(s) }
        return nil
    }
}
