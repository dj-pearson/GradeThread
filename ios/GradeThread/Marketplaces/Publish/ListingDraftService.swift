import Foundation
import GradeThreadCore
import Supabase

/// US-1970/US-1971: the draft columns the composer needs to seed its Best Offer
/// + schedule controls from the seller's ACTUAL saved choices, rather than from
/// the validate summary's *resolved* values.
///
/// The distinction matters: `summary.bestOfferAutoAccept` is what the server
/// resolved for this publish. Seeding a threshold box with it and then saving
/// would PIN a value the seller never typed into the column. So the boxes seed
/// from these columns and show the resolved value as a placeholder instead.
///
/// US-2405: the server no longer derives these from the comp band at all, so a
/// blank column means "no threshold, every offer waits for the seller" and the
/// placeholder is empty unless they set one.
///
/// A plain value type at file scope (not nested in the `@MainActor`
/// ``ListingDraftService``) so the composer can hold it as `@State` and pass it
/// around without inheriting actor isolation.
struct ListingDraftSettings: Equatable {
    var bestOfferEnabled: Bool
    var autoAcceptCents: Int?
    var autoDeclineCents: Int?
    var scheduledPublishAt: Date?
    /// US-1975: the seller's OWN auction terms, for the same reason as the Best
    /// Offer thresholds — `summary.auctionStartPrice` is the server's resolution
    /// (it falls back to the listing price), so seeding the box with it would pin
    /// a moving target into the override column on the next save.
    var auctionStartPriceCents: Int?
    var auctionReservePriceCents: Int?
    var auctionBuyItNowPriceCents: Int?
    var auctionDuration: String?
    /// US-1975: the RAW saved matrix — not `summary.variations`, which the server
    /// already normalized (an in-progress matrix with one in-stock row normalizes
    /// to null, and re-seeding from that would silently discard the seller's work).
    var variations: ListingVariationsPayload?
    /// US-3102: units to list. `listings.quantity` is NOT NULL with a default of
    /// 1, so nil here means "this item has no listing row yet", not "zero".
    var quantity: Int?

    /// No listing row yet (a camera-created item that was never saved), or the
    /// read failed — the composer falls back to the summary's own defaults.
    static let none = ListingDraftSettings(
        bestOfferEnabled: false, autoAcceptCents: nil,
        autoDeclineCents: nil, scheduledPublishAt: nil
    )

    /// The settings the draft holds once ``ListingDraftService/saveDraft`` has
    /// persisted `edits` — mirroring that method's write semantics exactly (a
    /// nil `bestOffer` / `.unchanged` schedule leaves the column alone).
    ///
    /// Lets the composer advance its baseline from what it just saved instead of
    /// re-reading the row. That's not just a saved round-trip: the composer
    /// re-seeds its threshold boxes from these values whenever it's rebuilt, so
    /// a stale baseline after a save (or after the save that precedes a FAILED
    /// push) would silently revert the seller's typed thresholds on retry —
    /// the US-1006 edit-preservation contract.
    func applying(
        _ edits: ComposerEdits,
        formatter: CurrencyFormatter = CurrencyFormatter()
    ) -> ListingDraftSettings {
        var next = self
        if let offer = edits.bestOffer {
            next.bestOfferEnabled = offer.enabled
            next.autoAcceptCents = BestOfferValidation.cents(offer.autoAcceptText, formatter: formatter)
            next.autoDeclineCents = BestOfferValidation.cents(offer.autoDeclineText, formatter: formatter)
        }
        switch edits.schedule {
        case .unchanged: break
        case .at(let date): next.scheduledPublishAt = date
        case .clear: next.scheduledPublishAt = nil
        }
        // US-1975: mirror the format write below — auction terms only persist for
        // an AUCTION draft (they're nulled for fixed price, so a format flip can't
        // leave stale terms behind), and variations only for a fixed-price one.
        if let choice = edits.listingFormat {
            let auction = choice.isAuction
            next.auctionStartPriceCents = auction
                ? BestOfferValidation.cents(choice.startPriceText, formatter: formatter) : nil
            next.auctionReservePriceCents = auction
                ? BestOfferValidation.cents(choice.reservePriceText, formatter: formatter) : nil
            next.auctionBuyItNowPriceCents = auction
                ? BestOfferValidation.cents(choice.buyItNowText, formatter: formatter) : nil
            next.auctionDuration = auction ? choice.duration : nil
            next.variations = auction ? nil : choice.variations?.payload(formatter: formatter)
        }
        return next
    }
}

/// US-1975: the `listings` format columns one save writes, resolved once so the
/// UPDATE and INSERT branches can't disagree about field ownership. `known ==
/// false` means the composer never showed the control, so the save must leave
/// every one of these columns untouched.
///
/// LOCKSTEP with the web composer's `buildFormatPayload` (composer.tsx): the two
/// clients write the same columns from the same rules, and
/// `assemblePublishContext` reads them without caring which one wrote.
private struct FormatColumns {
    let known: Bool
    let listingFormat: String?
    let startCents: Int?
    let reserveCents: Int?
    let buyItNowCents: Int?
    let duration: String?
    let variations: ListingVariationsPayload?

    init(_ choice: ComposerFormatChoice?, formatter: CurrencyFormatter = CurrencyFormatter()) {
        guard let choice else {
            known = false
            listingFormat = nil
            startCents = nil
            reserveCents = nil
            buyItNowCents = nil
            duration = nil
            variations = nil
            return
        }
        known = true
        listingFormat = choice.format.rawValue
        let auction = choice.isAuction
        startCents = auction ? BestOfferValidation.cents(choice.startPriceText, formatter: formatter) : nil
        reserveCents = auction ? BestOfferValidation.cents(choice.reservePriceText, formatter: formatter) : nil
        buyItNowCents = auction ? BestOfferValidation.cents(choice.buyItNowText, formatter: formatter) : nil
        duration = auction ? choice.duration : nil
        variations = auction ? nil : choice.variations?.payload(formatter: formatter)
    }
}

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

    private struct SettingsRow: Decodable {
        let best_offer_enabled: Bool?
        let best_offer_auto_accept_cents: Int?
        let best_offer_auto_decline_cents: Int?
        let scheduled_publish_at: String?
        // US-1975: the seller's own format overrides (see ListingDraftSettings).
        let auction_start_price_cents: Int?
        let auction_reserve_price_cents: Int?
        let auction_buy_it_now_price_cents: Int?
        let auction_duration: String?
        let variations: ListingVariationsPayload?
        let quantity: Int?
    }

    /// Read the composer-relevant settings off the item's most-recent eBay
    /// listing draft. Returns `.none` when the item has no listing row yet (a
    /// camera-created item that has never been saved) — the composer then starts
    /// from the summary's defaults. RLS scopes the read to the caller.
    func fetchSettings(inventoryItemId: String) async throws -> ListingDraftSettings {
        let rows: [SettingsRow] = try await supabase
            .from("listings")
            .select(
                "best_offer_enabled, best_offer_auto_accept_cents, "
                    + "best_offer_auto_decline_cents, scheduled_publish_at, "
                    + "auction_start_price_cents, auction_reserve_price_cents, "
                    + "auction_buy_it_now_price_cents, auction_duration, variations, quantity"
            )
            .eq("inventory_item_id", value: inventoryItemId)
            .eq("platform", value: "ebay")
            .order("created_at", ascending: false)
            .limit(1)
            .execute()
            .value
        guard let row = rows.first else { return .none }
        return ListingDraftSettings(
            bestOfferEnabled: row.best_offer_enabled ?? false,
            autoAcceptCents: row.best_offer_auto_accept_cents,
            autoDeclineCents: row.best_offer_auto_decline_cents,
            // The column is a timestamptz; PostgREST emits fractional seconds,
            // which the default `.iso8601` strategy rejects — so parse through
            // the fractional-tolerant helper (US-1127 pattern).
            scheduledPublishAt: row.scheduled_publish_at.flatMap(ScheduledDropScheduling.parseTimestamp),
            auctionStartPriceCents: row.auction_start_price_cents,
            auctionReservePriceCents: row.auction_reserve_price_cents,
            auctionBuyItNowPriceCents: row.auction_buy_it_now_price_cents,
            auctionDuration: row.auction_duration,
            variations: row.variations,
            quantity: row.quantity
        )
    }

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

    /// US-1971: the `scheduled_publish_at` value for a freshly INSERTed draft.
    /// `.unchanged` and `.clear` are both simply "not scheduled" on a new row
    /// (there's no prior value to preserve or cancel), so both encode to nil and
    /// the column takes its null default.
    nonisolated static func scheduleInsertValue(_ schedule: ComposerScheduleEdit) -> String? {
        switch schedule {
        case .at(let date): return ScheduledDropScheduling.isoString(date)
        case .unchanged, .clear: return nil
        }
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

        // US-1264: template-applied fields are persisted onto the SAME draft so
        // the server-side publish context picks them up (it reads
        // platform_category_id / item_specifics_override / *_policy_id straight
        // off the listing row — see assemblePublishContext). They're nil/empty
        // when no template was applied, and supabase-swift omits a nil optional
        // from an `.update`, so an unset field never clobbers an existing draft
        // value — matching AutoLister's overlay, which only writes provided keys.
        // US-1505: persist item_specifics_override as [String: [String]] — the
        // shape every edge publish/revise consumer (and SpecificsEditorModel)
        // expects. Writing bare {String:String} threw a TypeError in the edge
        // aspect-reconcile path that surfaced as a bogus "Could not load eBay
        // specifics" publish blocker. Drop blank values so we never write an
        // aspect eBay would reject.
        let itemSpecificsArrayed: [String: [String]] = edits.itemSpecifics.reduce(
            into: [:]
        ) { acc, pair in
            let v = pair.value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !v.isEmpty { acc[pair.key] = [v] }
        }
        let itemSpecificsOrNil = itemSpecificsArrayed.isEmpty ? nil : itemSpecificsArrayed

        // US-1970: nil `bestOfferEnabled` = the control wasn't shown → leave all
        // three columns alone. When it WAS shown, both thresholds are written
        // explicitly (null-able), because a cleared box must be able to return
        // to "use the comp-derived default" — nil-omission would leave a stale
        // pinned threshold shadowing the suggestion (the US-1512 promo lesson).
        let bestOfferEnabled = edits.bestOffer?.enabled
        let acceptCents = edits.bestOffer.flatMap { BestOfferValidation.cents($0.autoAcceptText) }
        let declineCents = edits.bestOffer.flatMap { BestOfferValidation.cents($0.autoDeclineText) }

        // US-1975: nil `listingFormat` = the control wasn't shown → leave the
        // format columns alone. When it WAS shown we write the whole set, with
        // the same field ownership the web composer's `buildFormatPayload` uses:
        // auction terms are nulled for a fixed-price draft and variations for an
        // auction (eBay has no multi-variation auction), so flipping the format
        // can never leave the other side's stale values to be picked up by
        // `assemblePublishContext`.
        let format = FormatColumns(edits.listingFormat)

        if let row = existing.first {
            struct Update: Encodable {
                // US-1648: the composer's price must persist on a re-save too —
                // the UPDATE branch previously dropped it (only INSERT + the
                // dedicated PriceUpdate wrote it), so an edited price silently
                // reverted on the next Save in the composer.
                let listing_price: Double
                let listing_title: String
                let listing_description: String
                let ebay_condition: String
                let ebay_condition_description: String?
                let item_specifics_override: [String: [String]]?
                let platform_category_id: String?
                let return_policy_id: String?
                let shipping_policy_id: String?
                let payment_policy_id: String?
                // US-1512: the composer's Promoted Listings choice. `nil`
                // promo_opt_out = control not shown → leave both columns alone.
                let promo_opt_out: Bool?
                let promo_rate_pct: Double?
                // US-1970: nil best_offer_enabled = control not shown → leave
                // the three best-offer columns alone.
                let best_offer_enabled: Bool?
                let best_offer_auto_accept_cents: Int?
                let best_offer_auto_decline_cents: Int?
                // US-1971: .unchanged leaves an existing scheduled drop alone.
                let schedule: ComposerScheduleEdit
                // US-1975: `known == false` leaves every format column alone.
                let format: FormatColumns
                /// US-3102: nil = the control was never shown (auction, or a
                /// variation matrix that carries per-variant quantities), so the
                /// column is omitted and whatever is there survives.
                let quantity: Int?

                enum CodingKeys: String, CodingKey {
                    case listing_price
                    case listing_title, listing_description, ebay_condition
                    case ebay_condition_description, item_specifics_override
                    case platform_category_id, return_policy_id
                    case shipping_policy_id, payment_policy_id
                    case promo_opt_out, promo_rate_pct
                    case best_offer_enabled
                    case best_offer_auto_accept_cents
                    case best_offer_auto_decline_cents
                    case scheduled_publish_at
                    case listing_format
                    case auction_start_price_cents
                    case auction_reserve_price_cents
                    case auction_buy_it_now_price_cents
                    case auction_duration
                    case variations
                    case quantity
                }
                // US-1501: `ebay_condition_description` is encoded EXPLICITLY (null
                // when nil) so CLEARING the composer condition note actually clears
                // it server-side — the synthesized `encodeIfPresent` omitted a nil,
                // which left the old note on the draft (and it then republished). The
                // TEMPLATE fields below keep nil-omission on purpose (US-1264): an
                // unset field must not clobber an existing draft value.
                func encode(to encoder: Encoder) throws {
                    var c = encoder.container(keyedBy: CodingKeys.self)
                    try c.encode(listing_price, forKey: .listing_price)
                    try c.encode(listing_title, forKey: .listing_title)
                    try c.encode(listing_description, forKey: .listing_description)
                    try c.encode(ebay_condition, forKey: .ebay_condition)
                    try c.encode(ebay_condition_description, forKey: .ebay_condition_description)
                    try c.encodeIfPresent(item_specifics_override, forKey: .item_specifics_override)
                    try c.encodeIfPresent(platform_category_id, forKey: .platform_category_id)
                    try c.encodeIfPresent(return_policy_id, forKey: .return_policy_id)
                    try c.encodeIfPresent(shipping_policy_id, forKey: .shipping_policy_id)
                    try c.encodeIfPresent(payment_policy_id, forKey: .payment_policy_id)
                    // US-1512: when the promo control WAS shown, both columns are
                    // written explicitly — promo_rate_pct must be able to return
                    // to null ("use the category suggestion"), so nil-omission
                    // would leave a stale chosen rate shadowing the suggestion.
                    if let promoOptOut = promo_opt_out {
                        try c.encode(promoOptOut, forKey: .promo_opt_out)
                        try c.encode(promo_rate_pct, forKey: .promo_rate_pct)
                    }
                    // US-1970: same reasoning as promo — when the control was
                    // shown, write all three explicitly so clearing a threshold
                    // actually clears it (US-2405: cleared means no auto-accept
                    // or auto-decline at all, not "pick one from the comps").
                    if let bestOffer = best_offer_enabled {
                        try c.encode(bestOffer, forKey: .best_offer_enabled)
                        try c.encode(best_offer_auto_accept_cents, forKey: .best_offer_auto_accept_cents)
                        try c.encode(best_offer_auto_decline_cents, forKey: .best_offer_auto_decline_cents)
                    }
                    // US-1971: an explicit null CANCELS a scheduled drop; an
                    // omitted key leaves it untouched (ScheduledDropsService.cancel
                    // pattern — supabase-swift would otherwise drop the nil).
                    switch schedule {
                    case .unchanged:
                        break
                    case .at(let date):
                        try c.encode(
                            ScheduledDropScheduling.isoString(date), forKey: .scheduled_publish_at
                        )
                    case .clear:
                        try c.encodeNil(forKey: .scheduled_publish_at)
                    }
                    // US-1975: same reasoning as promo/Best Offer — when the
                    // control was shown, every format column is written
                    // EXPLICITLY (null included). Nil-omission would strand the
                    // old format's values: switching an auction draft back to
                    // fixed price would leave auction_start_price_cents set, and
                    // turning multi-variant off would leave the matrix in place
                    // for `assemblePublishContext` to publish anyway.
                    if format.known {
                        try c.encode(format.listingFormat, forKey: .listing_format)
                        try c.encode(format.startCents, forKey: .auction_start_price_cents)
                        try c.encode(format.reserveCents, forKey: .auction_reserve_price_cents)
                        try c.encode(format.buyItNowCents, forKey: .auction_buy_it_now_price_cents)
                        try c.encode(format.duration, forKey: .auction_duration)
                        try c.encode(format.variations, forKey: .variations)
                    }
                    // US-3102: nil-OMITTED, deliberately, unlike the format
                    // columns above. A quantity the composer never showed (an
                    // auction, a variation matrix) must leave the column alone;
                    // writing 1 over a seller's real number is the exact damage
                    // an explicit encode would do here.
                    try c.encodeIfPresent(quantity, forKey: .quantity)
                }
            }
            try await supabase
                .from("listings")
                .update(Update(
                    listing_price: listingPrice,
                    listing_title: edits.title,
                    listing_description: edits.description,
                    ebay_condition: edits.condition.rawValue,
                    ebay_condition_description: conditionDescriptionOrNil,
                    item_specifics_override: itemSpecificsOrNil,
                    platform_category_id: edits.ebayCategoryId,
                    return_policy_id: edits.returnPolicyId,
                    shipping_policy_id: edits.shippingPolicyId,
                    payment_policy_id: edits.paymentPolicyId,
                    quantity: edits.quantity,
                    promo_opt_out: edits.promoteEnabled.map { !$0 },
                    promo_rate_pct: edits.promoteEnabled == true ? edits.promoRatePct : nil,
                    best_offer_enabled: bestOfferEnabled,
                    best_offer_auto_accept_cents: acceptCents,
                    best_offer_auto_decline_cents: declineCents,
                    schedule: edits.schedule,
                    format: format
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
                let item_specifics_override: [String: [String]]?
                let platform_category_id: String?
                let return_policy_id: String?
                let shipping_policy_id: String?
                let payment_policy_id: String?
                // US-1512: synthesized nil-omission is correct here — a fresh row
                // falls back to the column defaults when the control wasn't shown,
                // and an explicit true/false (or chosen rate) is always encoded.
                let promo_opt_out: Bool?
                let promo_rate_pct: Double?
                // US-1970/US-1971: nil-omission is correct on a fresh row too —
                // best_offer_enabled defaults to false and scheduled_publish_at
                // to null, which is exactly "control not shown / not scheduled".
                let best_offer_enabled: Bool?
                let best_offer_auto_accept_cents: Int?
                let best_offer_auto_decline_cents: Int?
                let scheduled_publish_at: String?
                // US-1975: nil-omission is right on a fresh row too — the columns
                // default to fixed-price / no auction terms / no matrix, which is
                // exactly "the control wasn't shown".
                let listing_format: String?
                let auction_start_price_cents: Int?
                let auction_reserve_price_cents: Int?
                let auction_buy_it_now_price_cents: Int?
                /// US-3102: nil-omission again — the column defaults to 1.
                let quantity: Int?
                let auction_duration: String?
                let variations: ListingVariationsPayload?
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
                    ebay_condition_description: conditionDescriptionOrNil,
                    item_specifics_override: itemSpecificsOrNil,
                    platform_category_id: edits.ebayCategoryId,
                    return_policy_id: edits.returnPolicyId,
                    shipping_policy_id: edits.shippingPolicyId,
                    payment_policy_id: edits.paymentPolicyId,
                    promo_opt_out: edits.promoteEnabled.map { !$0 },
                    promo_rate_pct: edits.promoteEnabled == true ? edits.promoRatePct : nil,
                    best_offer_enabled: bestOfferEnabled,
                    best_offer_auto_accept_cents: acceptCents,
                    best_offer_auto_decline_cents: declineCents,
                    scheduled_publish_at: Self.scheduleInsertValue(edits.schedule),
                    listing_format: format.listingFormat,
                    auction_start_price_cents: format.startCents,
                    auction_reserve_price_cents: format.reserveCents,
                    auction_buy_it_now_price_cents: format.buyItNowCents,
                    auction_duration: format.duration,
                    variations: format.variations,
                    quantity: edits.quantity
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
///
/// US-1264: in addition to the free-text fields the seller types (title /
/// condition / note / description), the composer carries the non-text fields a
/// listing template applies — item specifics, eBay category, and the three
/// business policies. These aren't editable in the composer UI; they ride along
/// so ``ListingDraftService/saveDraft(inventoryItemId:priceValue:edits:)``
/// persists them onto the `listings` draft, where the server-side publish
/// context (`assemblePublishContext`) reads them — matching AutoLister, which
/// overlays the same template fields onto the draft server-side.
struct ComposerEdits: Equatable {
    let title: String
    let condition: EbayCondition
    let conditionDescription: String
    let description: String
    /// US-1242: the price the seller can set INLINE in the publish composer when
    /// the draft has no usable price — a zero-price draft otherwise dead-ends the
    /// dialog ("set a price on the canvas") with no way to fix it here. Blank =
    /// use the validated summary price; the parent's `saveDraft` prefers a
    /// non-blank value here so an inline fix reaches eBay.
    var price: String = ""
    /// Template-applied item specifics (e.g. ["Brand": "Levi's"]). Empty = none.
    var itemSpecifics: [String: String] = [:]
    /// Template-applied eBay leaf category id; nil = leave the draft's as-is.
    var ebayCategoryId: String? = nil
    var returnPolicyId: String? = nil
    var shippingPolicyId: String? = nil
    var paymentPolicyId: String? = nil
    /// US-1512: the composer's Promoted Listings choice. nil = the control was
    /// never shown (older edge without `promotedAdRate` in the summary), so
    /// `saveDraft` leaves `promo_opt_out`/`promo_rate_pct` untouched.
    var promoteEnabled: Bool? = nil
    /// US-1512: the seller's adjusted CPS ad rate (%). nil while
    /// `promoteEnabled == true` = keep/return to the category suggestion at
    /// publish (`promo_rate_pct` becomes null — the web composer's blank box).
    var promoRatePct: Double? = nil
    /// US-1970: the composer's Best Offer choice. nil = the control was never
    /// shown, so `saveDraft` leaves `best_offer_enabled` and both threshold
    /// columns untouched.
    var bestOffer: ComposerBestOffer? = nil
    /// US-1971: what to do with the draft's `scheduled_publish_at`.
    /// `.unchanged` (the default) leaves an existing scheduled drop alone.
    var schedule: ComposerScheduleEdit = .unchanged
    /// US-1975: the composer's listing format + auction terms + variation matrix.
    /// nil = the control was never shown, so `saveDraft` leaves `listing_format`,
    /// the `auction_*` columns, and `variations` untouched.
    var listingFormat: ComposerFormatChoice? = nil
    /// US-3102: units to list. nil = the control was never shown (an auction or
    /// a variation matrix, which carries a quantity per variant), so `saveDraft`
    /// leaves the column alone rather than writing a 1 over a real number.
    var quantity: Int? = nil
}

/// US-1972: what the composer currently holds, reported up to the parent on
/// every edit so the close confirmation can offer to SAVE what's typed rather
/// than only discard it. The parent can't rebuild this itself — the field state
/// lives in the form — and it can't wait for a Push, which is exactly the work
/// loss this story removes.
struct ComposerSnapshot: Equatable {
    var edits: ComposerEdits
    /// The edits are complete enough to persist (a title, a positive price, no
    /// contradictory Best Offer pair). Mirrors the commit row's gate MINUS the
    /// network/in-flight conditions — those bear on whether a save can run right
    /// now, not on whether the content is savable.
    var canSave: Bool
}

/// US-1972: whether backgrounding the app should silently bank the composer's
/// edits. Pure so the rule — especially the schedule carve-out — is unit-tested
/// without a scene.
enum ComposerAutosave {
    /// A backgrounded composer autosaves only when the edits are worth writing,
    /// writable, and safe to write WITHOUT the seller confirming.
    ///
    /// The schedule carve-out is the subtle one: persisting an uncommitted
    /// `scheduled_publish_at` would arm the scheduled-publish worker and put the
    /// item live at a time the seller only ever previewed in the picker. So a
    /// pending schedule change is left for the explicit "Schedule publish"
    /// button. That costs nothing in the ordinary case — the form's state
    /// survives a background/foreground round-trip untouched; only an
    /// out-of-memory termination loses it, and publishing behind the seller's
    /// back is the worse of the two failures.
    static func shouldAutosave(
        isDirty: Bool,
        canSave: Bool,
        busy: Bool,
        schedule: ComposerScheduleEdit
    ) -> Bool {
        isDirty && canSave && !busy && schedule == .unchanged
    }
}

/// US-1264: pure, testable transform that computes the composer's field values
/// after applying a listing template. Mirrors AutoLister's server-side overlay
/// (`buildTemplateListingPatch`): description boilerplate is APPENDED (never
/// clobbered); condition, note, item specifics, category, and business policies
/// overwrite ONLY when the template actually provides them, so a sparse template
/// leaves the seller's existing values intact. Extracted from the SwiftUI view
/// so the apply behavior is unit-tested without instantiating it.
struct ComposerTemplateApply: Equatable {
    var description: String
    var condition: EbayCondition
    var conditionDescription: String
    var itemSpecifics: [String: String]
    var ebayCategoryId: String?
    var returnPolicyId: String?
    var shippingPolicyId: String?
    var paymentPolicyId: String?

    static func apply(
        template: ListingTemplate,
        description: String,
        condition: EbayCondition,
        conditionDescription: String,
        itemSpecifics: [String: String],
        ebayCategoryId: String?,
        returnPolicyId: String?,
        shippingPolicyId: String?,
        paymentPolicyId: String?
    ) -> ComposerTemplateApply {
        var result = ComposerTemplateApply(
            description: description,
            condition: condition,
            conditionDescription: conditionDescription,
            itemSpecifics: itemSpecifics,
            ebayCategoryId: ebayCategoryId,
            returnPolicyId: returnPolicyId,
            shippingPolicyId: shippingPolicyId,
            paymentPolicyId: paymentPolicyId
        )
        // Description: append the boilerplate below any existing text (US-972).
        if let boiler = template.descriptionTemplate, !boiler.isEmpty {
            let base = description.trimmingCharacters(in: .whitespacesAndNewlines)
            result.description = base.isEmpty ? boiler : "\(base)\n\n\(boiler)"
        }
        // Condition: overwrite only when the template sets a RECOGNIZED value
        // (US-1268 — an unrecognized/"No default" stored string is a no-op, not
        // a coerce-to-Excellent).
        if let cond = template.ebayCondition, let parsed = EbayCondition(rawValue: cond) {
            result.condition = parsed
        }
        if let note = template.conditionDescription, !note.isEmpty {
            result.conditionDescription = note
        }
        if !template.itemSpecifics.isEmpty {
            result.itemSpecifics = template.itemSpecifics
        }
        if let cat = template.ebayCategoryId, !cat.isEmpty {
            result.ebayCategoryId = cat
        }
        if let rp = template.returnPolicyId, !rp.isEmpty {
            result.returnPolicyId = rp
        }
        if let sp = template.shippingPolicyId, !sp.isEmpty {
            result.shippingPolicyId = sp
        }
        if let pp = template.paymentPolicyId, !pp.isEmpty {
            result.paymentPolicyId = pp
        }
        return result
    }
}
