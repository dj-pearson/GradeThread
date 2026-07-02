import Foundation

/// `POST /api/flipdesk/ebay/listings/validate` response. `ok` reflects
/// the absence of `blockers`; an empty `blockers` array means the push
/// can proceed.
struct ValidateResponse: Decodable, Equatable {
    let ok: Bool
    let blockers: [String]
    let summary: PublishSummary?
    /// US-828/US-1511: aspect values the server will OMIT from the eBay payload
    /// for value-validation reasons — the composer warns "X won't be sent" up
    /// front (the web has shown these since US-828; iOS silently dropped them).
    /// Optional — older edge responses may omit the field.
    let aspectDiagnostics: [AspectDiagnostic]?
}

/// US-828: one omitted-aspect diagnostic from the publish pre-flight. Keys are
/// verbatim (this service decodes with a plain JSONDecoder).
struct AspectDiagnostic: Decodable, Equatable {
    let aspect: String
    let omittedValues: [String]
    let reason: String?

    /// One warning line for the composer, e.g.
    /// `Material: "vegan leather" won't be sent (not an accepted eBay value).`
    var warningLine: String {
        let values = omittedValues.map { "\u{201C}\($0)\u{201D}" }.joined(separator: ", ")
        return "\(aspect): \(values) won\u{2019}t be sent (not an accepted eBay value)."
    }
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
    /// US-1237: the server-resolved eBay item specifics (Brand/Size/Color/…),
    /// so the composer's comp lookup can scope by brand + size the same way the
    /// item canvas does instead of searching on bare title with nil brand/size.
    /// Optional — older drafts / non-clothing items may omit it.
    let aspects: [String: [String]]?
    /// US-1512: the Promoted Listings ad rate the SERVER resolved for this
    /// publish (`resolvePublishAdRate` — the seller's chosen rate, else the
    /// category suggestion). `nil` = the seller opted out, so no ad attaches.
    /// Every publish otherwise silently attaches an ad at this rate, so the
    /// composer must disclose it (mirrors web US-561).
    let promotedAdRate: Double?
    /// US-1512: whether the server actually sent `promotedAdRate` (a JSON `null`
    /// and an ABSENT key both decode to nil). Only when true does the composer
    /// render the promotion control — an older edge that never resolves a rate
    /// must not be misread as "opted out".
    let promotedAdRateKnown: Bool

    private enum CodingKeys: String, CodingKey {
        case title, description, condition
        case conditionDescription = "conditionDescription"
        case priceValue = "priceValue"
        case currency
        case aspects
        case promotedAdRate
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decode(String.self, forKey: .description)
        condition = try c.decodeIfPresent(String.self, forKey: .condition)
        conditionDescription = try c.decodeIfPresent(String.self, forKey: .conditionDescription)
        priceValue = try c.decode(String.self, forKey: .priceValue)
        currency = try c.decodeIfPresent(String.self, forKey: .currency)
        aspects = try c.decodeIfPresent([String: [String]].self, forKey: .aspects)
        // US-1512: `contains` distinguishes "server resolved no ad (opt-out) →
        // null" from an older edge that omits the field entirely.
        promotedAdRateKnown = c.contains(.promotedAdRate)
        promotedAdRate = try c.decodeIfPresent(Double.self, forKey: .promotedAdRate)
    }

    /// Memberwise init for `merging`, tests, and previews (the custom Decodable
    /// init above replaces the synthesized one).
    init(
        title: String,
        description: String,
        condition: String?,
        conditionDescription: String?,
        priceValue: String,
        currency: String?,
        aspects: [String: [String]]?,
        promotedAdRate: Double? = nil,
        promotedAdRateKnown: Bool = false
    ) {
        self.title = title
        self.description = description
        self.condition = condition
        self.conditionDescription = conditionDescription
        self.priceValue = priceValue
        self.currency = currency
        self.aspects = aspects
        self.promotedAdRate = promotedAdRate
        self.promotedAdRateKnown = promotedAdRateKnown
    }

    /// US-1237: best-effort brand pulled from the eBay aspect map, used to
    /// narrow the composer's comp lookup. The aspect key is canonical-cased
    /// ("Brand"), but a decoder that camelCases nested jsonb could lower it, so
    /// look up both forms.
    var brand: String? { aspectValue(forKeys: "Brand", "brand") }

    /// US-1237: best-effort size pulled from the eBay aspect map (see `brand`).
    var size: String? { aspectValue(forKeys: "Size", "size") }

    private func aspectValue(forKeys keys: String...) -> String? {
        guard let aspects else { return nil }
        for key in keys {
            if let value = aspects[key]?.first(where: {
                !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }) {
                return value.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    /// Rebuilds a summary that reflects the user's in-progress composer edits,
    /// keeping price + currency from the validated `base`. Used to re-hydrate the
    /// composer after a transient publish failure so tapping "Try again" never
    /// wipes the title/condition/description the user just typed (US-1006).
    static func merging(_ edits: ComposerEdits, into base: PublishSummary) -> PublishSummary {
        let note = edits.conditionDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        // US-1242: an inline price fix wins over the (possibly zero) base price so
        // a resumed composer restores the value the seller just typed; a blank
        // edit keeps the validated base price.
        let editedPrice = edits.price.trimmingCharacters(in: .whitespacesAndNewlines)
        // US-1512: carry the promotion choice through a resume the same way —
        // opting out zeroes the resolved rate; an adjusted rate replaces it; an
        // untouched control keeps the server's resolution.
        let promotedAdRate: Double?
        switch edits.promoteEnabled {
        case .some(false): promotedAdRate = nil
        case .some(true): promotedAdRate = edits.promoRatePct ?? base.promotedAdRate
        case .none: promotedAdRate = base.promotedAdRate
        }
        return PublishSummary(
            title: edits.title,
            description: edits.description,
            condition: edits.condition.rawValue,
            conditionDescription: note.isEmpty ? nil : note,
            priceValue: editedPrice.isEmpty ? base.priceValue : editedPrice,
            currency: base.currency,
            aspects: base.aspects,
            promotedAdRate: promotedAdRate,
            promotedAdRateKnown: base.promotedAdRateKnown
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
    /// US-783/US-1511: true when the listing went LIVE on eBay but the local
    /// bookkeeping write failed and was queued for the next sync (a reconcile
    /// marker exists). The success card must say "live, syncing shortly" so the
    /// item not yet reading "listed" in-app doesn't look like a failed publish.
    let syncPending: Bool

    private enum CodingKeys: String, CodingKey {
        case ok
        case listingId = "listing_id"
        case listingURL = "listing_url"
        case offerId = "offer_id"
        case sku
        case syncPending = "sync_pending"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok)
        listingId = try c.decode(String.self, forKey: .listingId)
        listingURL = try c.decode(String.self, forKey: .listingURL)
        offerId = try c.decode(String.self, forKey: .offerId)
        sku = try c.decode(String.self, forKey: .sku)
        // Older edge responses omit it — absent means the local write succeeded.
        syncPending = try c.decodeIfPresent(Bool.self, forKey: .syncPending) ?? false
    }

    /// Memberwise init for tests / previews (the Decodable init above replaces
    /// the synthesized one).
    init(ok: Bool, listingId: String, listingURL: String, offerId: String, sku: String, syncPending: Bool = false) {
        self.ok = ok
        self.listingId = listingId
        self.listingURL = listingURL
        self.offerId = offerId
        self.sku = sku
        self.syncPending = syncPending
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
    /// US-1506: true only when eBay actually withdrew the live offer. When false,
    /// the listing was ended in FlipDesk ONLY (no linked offer, or eBay showed it
    /// already inactive) — surfacing `note` prevents "ended" reading as a full
    /// success when the eBay side may not have changed.
    let endedOnEbay: Bool
    /// Human-readable reason when the eBay withdraw didn't happen (nil on a clean
    /// eBay-side end).
    let note: String?

    private enum CodingKeys: String, CodingKey {
        case ok
        case listingId = "listing_id"
        case endedOnEbay = "ended_on_ebay"
        case note
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok)
        listingId = try c.decode(String.self, forKey: .listingId)
        // Older/edge-partial responses may omit these — default to a safe "eBay
        // side unconfirmed" rather than asserting a successful withdraw.
        endedOnEbay = try c.decodeIfPresent(Bool.self, forKey: .endedOnEbay) ?? false
        note = try c.decodeIfPresent(String.self, forKey: .note)
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
