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

    /// Rebuilds a summary that reflects the user's in-progress composer edits,
    /// keeping price + currency from the validated `base`. Used to re-hydrate the
    /// composer after a transient publish failure so tapping "Try again" never
    /// wipes the title/condition/description the user just typed (US-1006).
    static func merging(_ edits: ComposerEdits, into base: PublishSummary) -> PublishSummary {
        let note = edits.conditionDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return PublishSummary(
            title: edits.title,
            description: edits.description,
            condition: edits.condition.rawValue,
            conditionDescription: note.isEmpty ? nil : note,
            priceValue: base.priceValue,
            currency: base.currency
        )
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

/// `POST /api/flipdesk/ebay/listings/:id/revise` success response. Pushes
/// title / description / price / photo-order edits to a live listing in place.
struct ReviseResponse: Decodable, Equatable {
    let ok: Bool
    let listingId: String
    /// True when the inventory_item was re-PUT (photo set + order pushed).
    let photosSynced: Bool?

    private enum CodingKeys: String, CodingKey {
        case ok
        case listingId = "listing_id"
        case photosSynced = "photos_synced"
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

/// `402 PAYMENT_REQUIRED` body emitted by the edge plan gate (plan-gate.ts):
/// either a capacity cap (`CAP_REACHED`, e.g. the active-listings limit) or a
/// locked feature (`FEATURE_LOCKED`). Decoded so a bulk publish can surface a
/// friendly upgrade prompt instead of a raw error code, and stop the run early
/// because every further publish would hit the same cap (US-805 / US-820).
struct PlanGateBody: Decodable, Equatable {
    let error: String?
    let cap: String?
    let used: Int?
    let limit: Int?
    let plan: String?
    let requiredPlan: String?
    let feature: String?

    /// User-facing upgrade copy. Falls back to a generic line when the body
    /// doesn't carry the discriminator so the caller never shows a bare 402.
    var upgradeMessage: String {
        let upgrade = requiredPlan.map { " Upgrade to \(Self.prettyPlan($0)) to publish more." }
            ?? " Upgrade your plan to publish more."
        if error == "CAP_REACHED" {
            let what = cap == "activeListings" ? "active-listing" : (cap ?? "plan")
            if let limit {
                return "You've reached your \(what) limit (\(limit))." + upgrade
            }
            return "You've reached your \(what) limit." + upgrade
        }
        if error == "FEATURE_LOCKED" {
            return "This feature isn't available on your plan." + upgrade
        }
        return "You've reached your plan's limit." + upgrade
    }

    /// Best-effort decode of a 402 body into the upgrade message.
    static func planLimitMessage(from data: Data) -> String {
        (try? JSONDecoder().decode(PlanGateBody.self, from: data))?.upgradeMessage
            ?? "You've reached your plan's limit. Upgrade your plan to publish more."
    }

    private static func prettyPlan(_ raw: String) -> String {
        raw.split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
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
    /// HTTP 402 — a plan/usage cap blocks the publish (active-listings cap or a
    /// locked feature, US-805/US-820). Carries friendly upgrade copy; bulk
    /// callers stop the run because every further publish hits the same cap.
    case planLimit(message: String)
    case failed(message: String)
}

/// Typed outcome for the revise flow. Kept separate from ``PublishOutcome`` so
/// adding it doesn't force every exhaustive switch over that enum to change.
enum ReviseOutcome: Equatable {
    case revised(ReviseResponse)
    /// HTTP 409 — listing has no platform_offer_id (republish to enable edits).
    case noOfferId
    case failed(message: String)
}
