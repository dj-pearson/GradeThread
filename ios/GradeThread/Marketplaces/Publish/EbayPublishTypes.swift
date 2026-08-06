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
    /// US-1890/US-1896/US-1974: non-blocking title-quality (duplicate keyword,
    /// ALL-CAPS, promotional filler) and picture-standards findings. Advisory —
    /// unlike `blockers` these never stop a publish. Optional: an older edge
    /// omits the field, which decodes as "nothing to flag".
    let warnings: [String]?
    /// US-1895/US-1974: how many of eBay's RECOMMENDED item specifics the draft
    /// fills. Advisory (required specifics are a blocker); filling them lifts
    /// findability. Optional for the same back-compat reason as `warnings`.
    let recommendedCoverage: AspectCoverage?
    /// US-1897 (AC5): the 0–100 Listing Quality Score and its component
    /// breakdown, computed server-side from every verified ranking lever. The
    /// app renders it; it never recomputes the weights. Optional for the same
    /// back-compat reason as `warnings` — an older edge omits the field, which
    /// decodes as "not scored" and hides the block rather than showing a zero.
    let qualityScore: ListingQualityScore?

    /// Explicit memberwise init so the advisory fields (US-1974) default to nil —
    /// tests/previews that build a bare validated response keep compiling, and a
    /// future field here stays a one-line addition rather than a fan-out edit.
    init(
        ok: Bool,
        blockers: [String],
        summary: PublishSummary?,
        aspectDiagnostics: [AspectDiagnostic]? = nil,
        warnings: [String]? = nil,
        recommendedCoverage: AspectCoverage? = nil,
        qualityScore: ListingQualityScore? = nil
    ) {
        self.ok = ok
        self.blockers = blockers
        self.summary = summary
        self.aspectDiagnostics = aspectDiagnostics
        self.warnings = warnings
        self.recommendedCoverage = recommendedCoverage
        self.qualityScore = qualityScore
    }
}

/// US-1895/US-1974: recommended-aspect coverage from the publish pre-flight —
/// eBay's RECOMMENDED item specifics for the category, ranked by 30-day buyer
/// search volume (`aspect-provenance.ts` `recommendedAspectCoverage`). Keys are
/// verbatim (this service decodes with a plain JSONDecoder).
struct AspectCoverage: Decodable, Equatable {
    /// Recommended aspects carrying at least one non-empty value.
    let filled: Int
    /// Total recommended aspects for the resolved category. Zero when the
    /// category (and so its spec) couldn't be resolved — the meter stays hidden.
    let total: Int
    /// Unfilled recommended aspect names, most-searched first.
    let missing: [String]

    init(filled: Int, total: Int, missing: [String] = []) {
        self.filled = filled
        self.total = total
        self.missing = missing
    }

    private enum CodingKeys: String, CodingKey {
        case filled, total, missing
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A partial payload degrades to "no coverage known" rather than failing
        // the whole validate decode over an advisory field.
        filled = try c.decodeIfPresent(Int.self, forKey: .filled) ?? 0
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        missing = try c.decodeIfPresent([String].self, forKey: .missing) ?? []
    }

    /// 0–100, clamped. Zero when the category spec is unknown (`total == 0`).
    var pct: Int {
        guard total > 0 else { return 0 }
        return min(100, max(0, Int((Double(filled) / Double(total) * 100).rounded())))
    }

    /// Every recommended specific filled — the meter reads green.
    var isComplete: Bool { total > 0 && filled >= total }

    /// The meter renders only once the server actually resolved a category spec.
    var isMeaningful: Bool { total > 0 }
}

/// US-1974: the composer's title-quality meter. eBay's 80-character title is the
/// primary retrieval surface, so 70–80 is the green sweet spot and anything
/// shorter wastes reach. Pure, and a LOCKSTEP mirror of the web composer's
/// `titleUtilization` (src/lib/title-quality.ts) — the two projects can't import
/// each other, so keep the bands identical.
///
/// The QUALITY findings themselves (duplicate keywords, ALL-CAPS, filler) come
/// from the server (`ValidateResponse.warnings`, US-1890) rather than being
/// re-implemented here — one lint, one source of truth.
enum ComposerTitleQuality {
    /// eBay's hard title cap.
    static let limit = 80
    /// Below this the title under-uses the search surface (web `TITLE_GREEN_MIN`).
    static let greenMin = 70

    enum Band: Equatable {
        case empty
        /// Under the green minimum — usable, but leaving retrieval reach unused.
        case low
        /// The 70–80 sweet spot.
        case good
        /// At the cap; further keystrokes are truncated.
        case full
    }

    struct Utilization: Equatable {
        let used: Int
        let limit: Int
        /// 0–100, capped at 100.
        let pct: Int
        let band: Band
    }

    static func utilization(_ title: String, limit: Int = ComposerTitleQuality.limit) -> Utilization {
        let used = title.trimmingCharacters(in: .whitespacesAndNewlines).count
        let pct = limit > 0 ? min(100, Int((Double(used) / Double(limit) * 100).rounded())) : 0
        let band: Band
        if used == 0 {
            band = .empty
        } else if used >= limit {
            band = .full
        } else if used >= greenMin {
            band = .good
        } else {
            band = .low
        }
        return Utilization(used: used, limit: limit, pct: pct, band: band)
    }
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
    /// US-1975: the eBay offer format this publish resolves to — `"FIXED_PRICE"`
    /// or `"AUCTION"` (derived server-side from `listings.listing_format`). The
    /// edge has always sent it; iOS never read it, so every iOS publish was
    /// fixed-price. An absent key decodes as fixed price, matching the column
    /// default.
    let format: String?
    /// US-1975: the RESOLVED auction terms as eBay money strings — `nil` for a
    /// fixed-price draft. `auctionStartPrice` falls back to the listing price
    /// server-side when the seller set no explicit starting bid, so it's a
    /// suggestion to show as a placeholder, NOT a value to seed the box with
    /// (that would pin it into the override column — the US-1512/US-1970 trap).
    let auctionStartPrice: String?
    let auctionReservePrice: String?
    let auctionBuyItNowPrice: String?
    /// US-1975: `DAYS_n` for an auction, `GTC` for fixed price.
    let auctionDuration: String?
    /// US-1975: the multi-variant matrix the publish will send, already
    /// NORMALIZED by the server (`normalizeVariations` drops out-of-stock and
    /// malformed variants, and returns null below two purchasable combinations).
    /// So this reflects what would publish — not necessarily what's saved on the
    /// draft; the editor seeds from the raw column instead.
    let variations: ListingVariationsPayload?

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
        case format
        case auctionStartPrice
        case auctionReservePrice
        case auctionBuyItNowPrice
        case auctionDuration
        case variations
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
        // US-1975: an older edge that omits these decodes as a plain fixed-price
        // single-variant publish — exactly what iOS did before this story.
        format = try c.decodeIfPresent(String.self, forKey: .format)
        auctionStartPrice = try c.decodeIfPresent(String.self, forKey: .auctionStartPrice)
        auctionReservePrice = try c.decodeIfPresent(String.self, forKey: .auctionReservePrice)
        auctionBuyItNowPrice = try c.decodeIfPresent(String.self, forKey: .auctionBuyItNowPrice)
        auctionDuration = try c.decodeIfPresent(String.self, forKey: .auctionDuration)
        variations = try c.decodeIfPresent(ListingVariationsPayload.self, forKey: .variations)
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
        bestOfferAutoDecline: String? = nil,
        format: String? = nil,
        auctionStartPrice: String? = nil,
        auctionReservePrice: String? = nil,
        auctionBuyItNowPrice: String? = nil,
        auctionDuration: String? = nil,
        variations: ListingVariationsPayload? = nil
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
        self.format = format
        self.auctionStartPrice = auctionStartPrice
        self.auctionReservePrice = auctionReservePrice
        self.auctionBuyItNowPrice = auctionBuyItNowPrice
        self.auctionDuration = auctionDuration
        self.variations = variations
    }

    /// US-1975: the format the composer seeds its selector from.
    var composerFormat: ComposerListingFormat { ComposerListingFormat(summaryFormat: format) }

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
                ?? base.bestOfferAutoDecline,
            // US-1975: the composer seeds its format SELECTOR from the summary
            // (the draft-settings read fails soft to `.none`, and misreading an
            // auction draft as fixed price would silently rewrite the format on
            // the next save), so a resume must carry the seller's choice here or
            // "Try again" reverts it. The auction PRICE strings stay the base's
            // resolution — they're placeholders; the typed values live in the
            // draft settings, which the push already advanced (`applying`).
            format: edits.listingFormat.map(\.format.summaryFormat) ?? base.format,
            auctionStartPrice: base.auctionStartPrice,
            auctionReservePrice: base.auctionReservePrice,
            auctionBuyItNowPrice: base.auctionBuyItNowPrice,
            auctionDuration: base.auctionDuration,
            variations: base.variations
        )
    }
}

// MARK: - Composer listing format + variations (US-1975)

/// US-1975: the two listing formats the composer offers. Raw values are the
/// `listings.listing_format` column's enum (LOCKSTEP with the web composer's
/// `LISTING_FORMATS` — the projects can't import each other).
enum ComposerListingFormat: String, CaseIterable, Identifiable, Equatable {
    case fixedPrice = "fixed_price"
    case auction

    var id: String { rawValue }

    /// Mirrors web `LISTING_FORMAT_LABELS`.
    var label: String {
        switch self {
        case .fixedPrice: return "Fixed price"
        case .auction: return "Auction"
        }
    }

    /// The eBay offer format the server resolves this to — the value that comes
    /// back on ``PublishSummary/format``.
    var summaryFormat: String {
        switch self {
        case .fixedPrice: return "FIXED_PRICE"
        case .auction: return "AUCTION"
        }
    }

    /// Seed from the validate summary's resolved offer format. Anything other
    /// than an explicit `"AUCTION"` (including an absent key on an older edge)
    /// is fixed price, matching the server's own `listing_format === "auction"`
    /// test and the column default.
    init(summaryFormat: String?) {
        self = summaryFormat == "AUCTION" ? .auction : .fixedPrice
    }
}

/// US-1975: eBay's `listingDuration` values valid for an auction offer, plus
/// their labels. LOCKSTEP with web `AUCTION_DURATIONS` / `AUCTION_DURATION_LABELS`.
enum AuctionDuration {
    static let all = ["DAYS_1", "DAYS_3", "DAYS_5", "DAYS_7", "DAYS_10"]
    /// What the server falls back to for an auction draft with no stored
    /// duration (`assemblePublishContext`), so the picker starts there too.
    static let fallback = "DAYS_7"

    static func label(_ raw: String) -> String {
        switch raw {
        case "DAYS_1": return "1 day"
        case "DAYS_3": return "3 days"
        case "DAYS_5": return "5 days"
        case "DAYS_7": return "7 days"
        case "DAYS_10": return "10 days"
        default: return raw
        }
    }

    /// An unknown/absent stored duration resolves to the server's own fallback
    /// rather than showing the seller a value eBay would reject.
    static func normalize(_ raw: String?) -> String {
        guard let raw, all.contains(raw) else { return fallback }
        return raw
    }
}

/// US-1975: one variant of a multi-variant listing, as persisted in the
/// `listings.variations` jsonb. Wire shape — keys are VERBATIM snake_case: both
/// readers use a decoder with no key strategy (the publish service's plain
/// `JSONDecoder`, and supabase-swift's PostgREST client).
struct ListingVariantPayload: Codable, Equatable {
    /// The varies-by values for this combination, e.g. `["Size": "M"]`. Every
    /// specification must have a value or the server drops the variant.
    var aspects: [String: String]
    var quantity: Int
    var priceCents: Int?
    var skuSuffix: String?

    enum CodingKeys: String, CodingKey {
        case aspects, quantity
        case priceCents = "price_cents"
        case skuSuffix = "sku_suffix"
    }

    init(aspects: [String: String], quantity: Int, priceCents: Int? = nil, skuSuffix: String? = nil) {
        self.aspects = aspects
        self.quantity = quantity
        self.priceCents = priceCents
        self.skuSuffix = skuSuffix
    }

    /// Tolerant decode: this reads a free-form jsonb column that predates iOS
    /// (the web composer and AutoLister both write it). A partial row degrades
    /// to an empty/zero variant — which the editor and the server both drop —
    /// rather than throwing and taking the whole draft read (and so the seller's
    /// saved matrix) down with it.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        aspects = try c.decodeIfPresent([String: String].self, forKey: .aspects) ?? [:]
        quantity = try c.decodeIfPresent(Int.self, forKey: .quantity) ?? 0
        priceCents = try c.decodeIfPresent(Int.self, forKey: .priceCents)
        skuSuffix = try c.decodeIfPresent(String.self, forKey: .skuSuffix)
    }
}

/// US-1975: the shape of `listings.variations` — the varies-by aspect names plus
/// every combination. Mirrors web `ListingVariations` / the edge's interface.
struct ListingVariationsPayload: Codable, Equatable {
    var specifications: [String]
    var variants: [ListingVariantPayload]

    /// Declared explicitly rather than left to synthesis — the custom
    /// `init(from:)` below is exactly the case where relying on the synthesized
    /// keys has bitten this file before.
    enum CodingKeys: String, CodingKey {
        case specifications, variants
    }

    init(specifications: [String], variants: [ListingVariantPayload]) {
        self.specifications = specifications
        self.variants = variants
    }

    /// Tolerant for the same reason as ``ListingVariantPayload/init(from:)``.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        specifications = try c.decodeIfPresent([String].self, forKey: .specifications) ?? []
        variants = try c.decodeIfPresent([ListingVariantPayload].self, forKey: .variants) ?? []
    }
}

/// US-1975: one editable row of the composer's variation matrix. Quantity and
/// price are held as the raw strings the seller typed (parsed at the boundary —
/// price through the locale-tolerant ``CurrencyFormatter``, never `Double(_:)`).
/// A blank price means "use the listing price for this variant".
struct ComposerVariant: Equatable, Identifiable {
    let id: UUID
    var aspects: [String: String]
    var quantityText: String
    var priceText: String

    init(
        id: UUID = UUID(),
        aspects: [String: String] = [:],
        quantityText: String = "1",
        priceText: String = ""
    ) {
        self.id = id
        self.aspects = aspects
        self.quantityText = quantityText
        self.priceText = priceText
    }

    /// Whole units, floored at 0. A `.numberPad` gives digits only, so a plain
    /// `Int` parse is right here — unlike the price, which is locale-formatted.
    var quantity: Int {
        max(0, Int(quantityText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0)
    }

    /// Equality is over the CONTENT, deliberately ignoring `id`: the composer's
    /// dirty check rebuilds its seed baseline on every render, which mints fresh
    /// ids — an id-sensitive `==` would report a phantom edit immediately and
    /// permanently (the dirty ratchet never resets), blocking swipe-dismiss on a
    /// composer the seller never touched. `id` exists only for `ForEach`.
    static func == (lhs: ComposerVariant, rhs: ComposerVariant) -> Bool {
        lhs.aspects == rhs.aspects
            && lhs.quantityText == rhs.quantityText
            && lhs.priceText == rhs.priceText
    }
}

/// US-1975: the composer's size/color matrix.
struct ComposerVariations: Equatable {
    var specifications: [String]
    var variants: [ComposerVariant]

    /// The varies-by specs a clothing seller actually uses — same pair the web
    /// editor offers.
    static let specOptions = ["Size", "Color"]

    /// A fresh matrix: varies by Size, with the two rows eBay needs at minimum
    /// for a multi-variation listing (fewer and the server publishes it as a
    /// plain single-SKU listing instead).
    static func seeded() -> ComposerVariations {
        ComposerVariations(
            specifications: ["Size"],
            variants: [ComposerVariant(aspects: ["Size": ""]), ComposerVariant(aspects: ["Size": ""])]
        )
    }

    /// Seed the editor from the saved column.
    init(payload: ListingVariationsPayload) {
        let specs = payload.specifications.isEmpty ? ["Size"] : payload.specifications
        var rows = payload.variants.map { variant -> ComposerVariant in
            var aspects: [String: String] = [:]
            for spec in specs { aspects[spec] = variant.aspects[spec] ?? "" }
            return ComposerVariant(
                aspects: aspects,
                quantityText: String(max(0, variant.quantity)),
                priceText: variant.priceCents.map { ComposerVariations.priceText($0) } ?? ""
            )
        }
        // A saved-but-empty matrix still opens the editor with rows to fill,
        // rather than a variation listing with nothing in it.
        if rows.isEmpty { rows = ComposerVariations.seeded().variants }
        specifications = specs
        variants = rows
    }

    init(specifications: [String], variants: [ComposerVariant]) {
        self.specifications = specifications
        self.variants = variants
    }

    /// cents → an editable, LOCALE-formatted string that round-trips back through
    /// `CurrencyFormatter().parse` (US-1236 — `String(format:"%.2f")` would pin a
    /// "." separator a comma-decimal locale then misreads).
    private static func priceText(_ cents: Int) -> String {
        DraftEditRow.priceString2dp(Double(cents) / 100)
    }

    /// The persistable matrix, or nil when there's nothing publishable. Mirrors
    /// the server's `normalizeVariations` so what we save is what it will send:
    /// blank aspect values drop the variant, out-of-stock rows drop, and fewer
    /// than two purchasable combinations is not a variation listing at all.
    func payload(formatter: CurrencyFormatter = CurrencyFormatter()) -> ListingVariationsPayload? {
        let specs = specifications
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !specs.isEmpty else { return nil }
        let rows: [ListingVariantPayload] = variants.compactMap { variant -> ListingVariantPayload? in
            var aspects: [String: String] = [:]
            for spec in specs {
                let value = (variant.aspects[spec] ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty else { return nil }
                aspects[spec] = value
            }
            guard variant.quantity > 0 else { return nil }
            return ListingVariantPayload(
                aspects: aspects,
                quantity: variant.quantity,
                priceCents: BestOfferValidation.cents(variant.priceText, formatter: formatter)
            )
        }
        guard rows.count >= 2 else { return nil }
        return ListingVariationsPayload(specifications: specs, variants: rows)
    }
}

/// US-1975: the composer's format choice — the selector, the auction terms as
/// the raw strings the seller typed, and the variation matrix. Auction and
/// variations are MUTUALLY EXCLUSIVE (eBay has no multi-variation auction), so
/// the editor clears one when the other is chosen.
///
/// An empty auction box means "let the server resolve it" (the starting bid
/// falls back to the listing price; reserve and Buy It Now simply don't apply) —
/// it is not zero.
struct ComposerFormatChoice: Equatable {
    var format: ComposerListingFormat
    var startPriceText: String
    var reservePriceText: String
    var buyItNowText: String
    var duration: String
    /// nil = single-SKU listing.
    var variations: ComposerVariations?

    init(
        format: ComposerListingFormat = .fixedPrice,
        startPriceText: String = "",
        reservePriceText: String = "",
        buyItNowText: String = "",
        duration: String = AuctionDuration.fallback,
        variations: ComposerVariations? = nil
    ) {
        self.format = format
        self.startPriceText = startPriceText
        self.reservePriceText = reservePriceText
        self.buyItNowText = buyItNowText
        self.duration = duration
        self.variations = variations
    }

    var isAuction: Bool { format == .auction }

    /// eBay does not allow Best Offer on an auction offer, and the server
    /// suppresses `bestOfferTerms` unless the format is FIXED_PRICE — so the
    /// composer hides the control rather than showing terms that get dropped.
    var allowsBestOffer: Bool { !isAuction }
}

/// US-1975: pure validation for the format editor. The server defensively drops
/// whatever it can't use (an under-filled matrix silently becomes a single-SKU
/// listing; a blank starting bid becomes the listing price) — which is right for
/// the server and wrong for the seller, who deserves to know BEFORE tapping Push
/// that the auction/matrix they built isn't the one that will publish.
enum ListingFormatValidation {
    /// The blocking problem with this format configuration, or nil when it's
    /// publishable. `priceCents` is the effective listing price in cents; pass 0
    /// when it isn't known yet (the composer blocks Push on an invalid price
    /// separately, so the price-relative rules stay quiet).
    static func error(
        _ choice: ComposerFormatChoice,
        priceCents: Int,
        formatter: CurrencyFormatter = CurrencyFormatter()
    ) -> String? {
        choice.isAuction
            ? auctionError(choice, priceCents: priceCents, formatter: formatter)
            : variationsError(choice, formatter: formatter)
    }

    private static func auctionError(
        _ choice: ComposerFormatChoice,
        priceCents: Int,
        formatter: CurrencyFormatter
    ) -> String? {
        let start = cents(choice.startPriceText, formatter: formatter)
        if filled(choice.startPriceText), start == nil {
            return "Enter a starting bid greater than 0, or leave it blank to start at the listing price."
        }
        if filled(choice.reservePriceText), cents(choice.reservePriceText, formatter: formatter) == nil {
            return "Enter a reserve price greater than 0, or leave it blank for no reserve."
        }
        if filled(choice.buyItNowText), cents(choice.buyItNowText, formatter: formatter) == nil {
            return "Enter a Buy It Now price greater than 0, or leave it blank for none."
        }
        // A blank starting bid publishes at the listing price (the server's
        // fallback), so that's what the reserve/BIN rules compare against.
        let effectiveStart = start ?? (priceCents > 0 ? priceCents : nil)
        if let reserve = cents(choice.reservePriceText, formatter: formatter),
           let effectiveStart, reserve < effectiveStart {
            return "Reserve price must be at or above the starting bid."
        }
        if let bin = cents(choice.buyItNowText, formatter: formatter) {
            if let effectiveStart, bin <= effectiveStart {
                return "Buy It Now must be above the starting bid."
            }
            if let reserve = cents(choice.reservePriceText, formatter: formatter), bin < reserve {
                return "Buy It Now must be at or above the reserve price."
            }
        }
        if !AuctionDuration.all.contains(choice.duration) {
            return "Pick an auction duration."
        }
        return nil
    }

    private static func variationsError(
        _ choice: ComposerFormatChoice,
        formatter: CurrencyFormatter
    ) -> String? {
        guard let variations = choice.variations else { return nil }
        if variations.specifications.isEmpty {
            return "Pick at least one thing the listing varies by."
        }
        for variant in variations.variants {
            for spec in variations.specifications {
                let value = (variant.aspects[spec] ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if value.isEmpty {
                    return "Give every variant a \(spec.lowercased())."
                }
            }
            if filled(variant.priceText), cents(variant.priceText, formatter: formatter) == nil {
                return "Enter a variant price greater than 0, or leave it blank to use the listing price."
            }
        }
        // The matrix eBay would actually receive — the server drops out-of-stock
        // rows, so "two rows, one in stock" is a single-SKU listing in disguise.
        guard let payload = variations.payload(formatter: formatter) else {
            return "Add at least two in-stock variants, or turn off multi-variant."
        }
        let combinations = payload.variants.map { variant in
            payload.specifications.map { variant.aspects[$0] ?? "" }.joined(separator: "\u{1F}")
        }
        if Set(combinations).count != combinations.count {
            return "Each variant must be a different combination."
        }
        return nil
    }

    private static func filled(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Money parsing is identical to the Best Offer thresholds' (locale-tolerant,
    /// positive-only, whole cents) — one rule, one implementation.
    private static func cents(_ text: String, formatter: CurrencyFormatter) -> Int? {
        BestOfferValidation.cents(text, formatter: formatter)
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

    /// Memberwise init for tests / previews (the Decodable init above replaces
    /// the synthesized one).
    init(ok: Bool, listingId: String, endedOnEbay: Bool, note: String? = nil) {
        self.ok = ok
        self.listingId = listingId
        self.endedOnEbay = endedOnEbay
        self.note = note
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
