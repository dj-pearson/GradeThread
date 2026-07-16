import Foundation
import GradeThreadCore

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
    /// US-1970: whether the resolved publish will offer Best Offer. The server
    /// has always sent this on the validate summary; iOS simply never read it,
    /// so the toggle was unreachable from the phone.
    let bestOfferEnabled: Bool
    /// US-1970: the server-resolved auto-accept / auto-decline thresholds as
    /// eBay money strings, already clamped to `decline < accept < price`. `nil`
    /// = no threshold applies (Best Offer stays enabled, just unbounded), which
    /// the composer seeds as a blank box meaning "use the comp-derived default".
    let bestOfferAutoAccept: String?
    let bestOfferAutoDecline: String?

    private enum CodingKeys: String, CodingKey {
        case title, description, condition
        case conditionDescription = "conditionDescription"
        case priceValue = "priceValue"
        case currency
        case aspects
        case promotedAdRate
        case bestOfferEnabled
        case bestOfferAutoAccept
        case bestOfferAutoDecline
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
        // US-1970: an older edge that omits the key decodes as "off", matching
        // the column default (`best_offer_enabled boolean NOT NULL DEFAULT false`).
        bestOfferEnabled = try c.decodeIfPresent(Bool.self, forKey: .bestOfferEnabled) ?? false
        bestOfferAutoAccept = try c.decodeIfPresent(String.self, forKey: .bestOfferAutoAccept)
        bestOfferAutoDecline = try c.decodeIfPresent(String.self, forKey: .bestOfferAutoDecline)
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
        promotedAdRateKnown: Bool = false,
        bestOfferEnabled: Bool = false,
        bestOfferAutoAccept: String? = nil,
        bestOfferAutoDecline: String? = nil
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
        self.bestOfferEnabled = bestOfferEnabled
        self.bestOfferAutoAccept = bestOfferAutoAccept
        self.bestOfferAutoDecline = bestOfferAutoDecline
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

    /// US-1970: a blank (or whitespace-only) threshold box means "use the
    /// comp-derived suggestion", which is `nil` on the wire — not "".
    private static func blankToNil(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
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
            promotedAdRateKnown: base.promotedAdRateKnown,
            // US-1970: carry the Best Offer choice through a resume, the same way
            // the promotion choice is carried — a transient push failure must not
            // silently revert the seller's toggle/thresholds back to the server's
            // resolution. A blank threshold box stays blank (nil = "use the
            // comp-derived default"), so it round-trips as nil rather than
            // re-seeding the server's clamped number.
            bestOfferEnabled: edits.bestOffer?.enabled ?? base.bestOfferEnabled,
            bestOfferAutoAccept: edits.bestOffer.map { Self.blankToNil($0.autoAcceptText) }
                ?? base.bestOfferAutoAccept,
            bestOfferAutoDecline: edits.bestOffer.map { Self.blankToNil($0.autoDeclineText) }
                ?? base.bestOfferAutoDecline
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

// MARK: - Composer Best Offer + schedule (US-1970 / US-1971)

/// US-1970: the composer's Best Offer choice — the toggle plus the two optional
/// auto-clear thresholds, held as the raw strings the seller typed. They're
/// parsed at the boundary through the locale-tolerant ``CurrencyFormatter``,
/// never `Double(_:)`, so a de_DE seller typing "19,99" is read correctly.
///
/// An EMPTY threshold box means "use the comp-derived default" (the server
/// derives it from the p25/p75 comp columns and clamps it) — it is not zero.
struct ComposerBestOffer: Equatable {
    var enabled: Bool
    var autoAcceptText: String
    var autoDeclineText: String

    init(enabled: Bool, autoAcceptText: String = "", autoDeclineText: String = "") {
        self.enabled = enabled
        self.autoAcceptText = autoAcceptText
        self.autoDeclineText = autoDeclineText
    }

    /// Seed from a validated summary: the server's already-clamped resolution.
    init(summary: PublishSummary) {
        self.enabled = summary.bestOfferEnabled
        self.autoAcceptText = summary.bestOfferAutoAccept ?? ""
        self.autoDeclineText = summary.bestOfferAutoDecline ?? ""
    }
}

/// US-1970: pure validation + cents conversion for the Best Offer thresholds.
/// eBay requires `decline < accept < price`; the server clamps whatever it
/// resolves, but the composer must not send a self-contradictory pair — and the
/// seller deserves to see why before tapping Push. Pure + formatter-injectable,
/// so the rules are unit-tested without the view or a locale dependency.
enum BestOfferValidation {
    /// Parse a threshold box into whole cents. `nil` for an empty box ("use the
    /// comp-derived default") AND for an unparseable/non-positive one — callers
    /// separate the two via ``error(_:priceCents:formatter:)``, which rejects
    /// the latter rather than letting a typo fall back to the default.
    static func cents(_ text: String, formatter: CurrencyFormatter = CurrencyFormatter()) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let parsed = formatter.parse(trimmed) else { return nil }
        let normalized = Money.cents(parsed)
        guard normalized > 0 else { return nil }
        return Int((normalized * 100).rounded())
    }

    /// The blocking problem with this Best Offer configuration, or nil when it's
    /// publishable. `priceCents` is the effective listing price in cents; pass 0
    /// when it isn't known yet (the price rules then don't apply — the composer
    /// blocks Push on an invalid price separately).
    static func error(
        _ offer: ComposerBestOffer,
        priceCents: Int,
        formatter: CurrencyFormatter = CurrencyFormatter()
    ) -> String? {
        guard offer.enabled else { return nil }

        let acceptFilled = !offer.autoAcceptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let declineFilled = !offer.autoDeclineText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let accept = cents(offer.autoAcceptText, formatter: formatter)
        let decline = cents(offer.autoDeclineText, formatter: formatter)

        if acceptFilled, accept == nil {
            return "Enter an auto-accept price greater than 0, or leave it blank to use the suggested one."
        }
        if declineFilled, decline == nil {
            return "Enter an auto-decline price greater than 0, or leave it blank to use the suggested one."
        }
        if priceCents > 0, let accept, accept >= priceCents {
            return "Auto-accept must be below the listing price."
        }
        if priceCents > 0, let decline, decline >= priceCents {
            return "Auto-decline must be below the listing price."
        }
        if let accept, let decline, decline >= accept {
            return "Auto-decline must be below auto-accept."
        }
        return nil
    }
}

/// US-1971: what the composer's schedule control does to the draft's
/// `scheduled_publish_at` on save. An enum rather than a `Date??` so "leave the
/// column alone" and "clear it" stay distinguishable — the difference between
/// not touching an existing scheduled drop and cancelling one.
enum ComposerScheduleEdit: Equatable {
    /// The control wasn't touched — don't write the column.
    case unchanged
    /// Publish at this instant instead of now. The scheduled-publish worker
    /// (`scheduled_publish_at` due + not yet synced) picks the row up.
    case at(Date)
    /// Cancel any scheduled publish; the draft stays a draft.
    case clear
}
