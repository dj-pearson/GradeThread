import Foundation

/// `POST /api/flipdesk/ebay/listings/validate` response. `ok` reflects
/// the absence of `blockers`; an empty `blockers` array means the push
/// can proceed.
struct ValidateResponse: Decodable, Equatable {
    let ok: Bool
    let blockers: [String]
    let summary: PublishSummary?
}

/// Snapshot of what the push will send to eBay. Surfaced in the
/// review-screen card so the user can sanity-check title/price before
/// committing.
struct PublishSummary: Decodable, Equatable {
    let title: String
    let description: String
    /// `"NEW"` / `"USED_EXCELLENT"` etc. — eBay enum string.
    let condition: String?
    let conditionDescription: String?
    /// Decimal string. eBay's API is string-typed for money so we keep
    /// it that way client-side.
    let priceValue: String
    let currency: String?

    private enum CodingKeys: String, CodingKey {
        case title, description, condition
        case conditionDescription = "conditionDescription"
        case priceValue = "priceValue"
        case currency
    }
}

/// `POST /api/flipdesk/ebay/listings/push` success response (HTTP 200).
struct PushResponse: Decodable, Equatable {
    let ok: Bool
    let listingId: String
    let listingURL: String
    let offerId: String
    let sku: String

    private enum CodingKeys: String, CodingKey {
        case ok
        case listingId = "listing_id"
        case listingURL = "listing_url"
        case offerId = "offer_id"
        case sku
    }
}

/// `POST /api/flipdesk/ebay/listings/push` 422 response shape — payload
/// the user has to address before the push can run.
struct PushBlockersResponse: Decodable, Equatable {
    let ok: Bool
    let blockers: [String]
}

/// `POST /api/flipdesk/ebay/listings/:id/price` response.
struct PriceUpdateResponse: Decodable, Equatable {
    let ok: Bool
    let listingId: String
    let price: Double

    private enum CodingKeys: String, CodingKey {
        case ok
        case listingId = "listing_id"
        case price
    }
}

/// `DELETE /api/flipdesk/ebay/listings/:id` response.
struct EndListingResponse: Decodable, Equatable {
    let ok: Bool
    let listingId: String

    private enum CodingKeys: String, CodingKey {
        case ok
        case listingId = "listing_id"
    }
}

/// Generic error body the edge handlers emit. `detail` carries the
/// eBay-side message when one's available.
struct EdgeErrorBody: Decodable, Equatable {
    let error: String?
    let detail: String?

    /// Returns the most user-actionable string available.
    var message: String? {
        if let detail, !detail.isEmpty { return detail }
        return error
    }
}

/// Typed outcomes for the publish/price/end flows so callers can render
/// the right UI without sniffing HTTP codes.
enum PublishOutcome: Equatable {
    case validated(ValidateResponse)
    case pushed(PushResponse)
    case priceUpdated(PriceUpdateResponse)
    case ended(EndListingResponse)
    case blockers([String])
    /// HTTP 409 — listing has no platform_offer_id. iOS falls back to
    /// local-only behaviour with a toast.
    case noOfferId
    case failed(message: String)
}
