import XCTest
@testable import GradeThread

/// US-1975 — the composer's listing-format selector (fixed price / auction) and
/// the multi-variant matrix. The server has consumed `listing_format`, the
/// `auction_*` columns, and `variations` since US-568; iOS had no UI for any of
/// it, so every iOS publish was a fixed-price single-variant listing.
///
/// These cover the PURE pieces the view is built on: decoding the validate
/// summary's format fields, the validation rules, the matrix ↔ column shape
/// (which must mirror the server's `normalizeVariations` — what we save has to be
/// what it publishes), the resume merge, and the write semantics.
final class ComposerListingFormatTests: XCTestCase {

    // MARK: - Fixtures

    /// Locale pinned so the money assertions don't depend on the host.
    private let usFormatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))

    private func summary(
        priceValue: String = "42.00",
        format: String? = nil,
        auctionStartPrice: String? = nil,
        auctionDuration: String? = nil
    ) -> PublishSummary {
        PublishSummary(
            title: "Server title",
            description: "Server description",
            condition: "USED_GOOD",
            conditionDescription: nil,
            priceValue: priceValue,
            currency: "USD",
            aspects: nil,
            format: format,
            auctionStartPrice: auctionStartPrice,
            auctionDuration: auctionDuration
        )
    }

    private func edits(listingFormat: ComposerFormatChoice? = nil) -> ComposerEdits {
        ComposerEdits(
            title: "Edited title",
            condition: .usedExcellent,
            conditionDescription: "",
            description: "Edited description",
            listingFormat: listingFormat
        )
    }

    private func variant(
        size: String = "M", quantity: String = "1", price: String = ""
    ) -> ComposerVariant {
        ComposerVariant(aspects: ["Size": size], quantityText: quantity, priceText: price)
    }

    private func matrix(_ variants: [ComposerVariant]) -> ComposerFormatChoice {
        ComposerFormatChoice(
            format: .fixedPrice,
            variations: ComposerVariations(specifications: ["Size"], variants: variants)
        )
    }

    // MARK: - Summary decoding

    func test_publishSummary_decodesFormatAndAuctionTerms() throws {
        let json = """
        {
          "title": "Vintage 501", "description": "Classic.", "priceValue": "42.00",
          "currency": "USD",
          "format": "AUCTION",
          "auctionStartPrice": "9.99",
          "auctionReservePrice": "25.00",
          "auctionBuyItNowPrice": "60.00",
          "auctionDuration": "DAYS_5"
        }
        """
        let parsed = try JSONDecoder().decode(PublishSummary.self, from: Data(json.utf8))
        XCTAssertEqual(parsed.format, "AUCTION")
        XCTAssertEqual(parsed.composerFormat, .auction)
        XCTAssertEqual(parsed.auctionStartPrice, "9.99")
        XCTAssertEqual(parsed.auctionReservePrice, "25.00")
        XCTAssertEqual(parsed.auctionBuyItNowPrice, "60.00")
        XCTAssertEqual(parsed.auctionDuration, "DAYS_5")
    }

    /// The matrix rides inside the summary with VERBATIM snake_case keys — the
    /// publish service decodes with a plain `JSONDecoder` (no key strategy).
    func test_publishSummary_decodesVariations() throws {
        let json = """
        {
          "title": "T", "description": "D", "priceValue": "42.00", "currency": "USD",
          "variations": {
            "specifications": ["Size"],
            "variants": [
              { "aspects": { "Size": "M" }, "quantity": 2, "price_cents": 4200, "sku_suffix": "M" },
              { "aspects": { "Size": "L" }, "quantity": 1, "price_cents": null, "sku_suffix": null }
            ]
          }
        }
        """
        let parsed = try JSONDecoder().decode(PublishSummary.self, from: Data(json.utf8))
        let variations = try XCTUnwrap(parsed.variations)
        XCTAssertEqual(variations.specifications, ["Size"])
        XCTAssertEqual(variations.variants.count, 2)
        XCTAssertEqual(variations.variants[0].aspects, ["Size": "M"])
        XCTAssertEqual(variations.variants[0].quantity, 2)
        XCTAssertEqual(variations.variants[0].priceCents, 4200)
        XCTAssertEqual(variations.variants[0].skuSuffix, "M")
        XCTAssertNil(variations.variants[1].priceCents)
    }

    /// An older edge omits every one of these — which must decode as the plain
    /// fixed-price single-variant publish iOS did before this story, not fail the
    /// whole composer.
    func test_publishSummary_formatAbsent_decodesAsFixedPrice() throws {
        let json = """
        { "title": "T", "description": "D", "priceValue": "42.00", "currency": "USD" }
        """
        let parsed = try JSONDecoder().decode(PublishSummary.self, from: Data(json.utf8))
        XCTAssertNil(parsed.format)
        XCTAssertEqual(parsed.composerFormat, .fixedPrice)
        XCTAssertNil(parsed.auctionStartPrice)
        XCTAssertNil(parsed.variations)
    }

    /// A partial/legacy jsonb row must not throw — that would take the whole
    /// draft read down and lose the seller's saved matrix.
    func test_variationsPayload_tolerantDecode() throws {
        let json = """
        { "specifications": ["Size"], "variants": [ { "aspects": { "Size": "M" } } ] }
        """
        let parsed = try JSONDecoder().decode(ListingVariationsPayload.self, from: Data(json.utf8))
        XCTAssertEqual(parsed.variants.first?.quantity, 0)
        XCTAssertNil(parsed.variants.first?.priceCents)
    }

    // MARK: - Format mapping

    func test_composerListingFormat_mapsToAndFromTheServer() {
        XCTAssertEqual(ComposerListingFormat(summaryFormat: "AUCTION"), .auction)
        XCTAssertEqual(ComposerListingFormat(summaryFormat: "FIXED_PRICE"), .fixedPrice)
        // Anything unrecognized is fixed price — the column default.
        XCTAssertEqual(ComposerListingFormat(summaryFormat: nil), .fixedPrice)
        XCTAssertEqual(ComposerListingFormat(summaryFormat: "garbage"), .fixedPrice)
        // The raw values ARE the listing_format column's enum.
        XCTAssertEqual(ComposerListingFormat.auction.rawValue, "auction")
        XCTAssertEqual(ComposerListingFormat.fixedPrice.rawValue, "fixed_price")
        XCTAssertEqual(ComposerListingFormat.auction.summaryFormat, "AUCTION")
    }

    func test_auctionDuration_normalizesToTheServersFallback() {
        XCTAssertEqual(AuctionDuration.normalize(nil), "DAYS_7")
        XCTAssertEqual(AuctionDuration.normalize("DAYS_99"), "DAYS_7")
        XCTAssertEqual(AuctionDuration.normalize("DAYS_1"), "DAYS_1")
        XCTAssertEqual(AuctionDuration.label("DAYS_10"), "10 days")
        // LOCKSTEP with web AUCTION_DURATIONS — eBay rejects any other value.
        XCTAssertEqual(AuctionDuration.all, ["DAYS_1", "DAYS_3", "DAYS_5", "DAYS_7", "DAYS_10"])
    }

    /// eBay allows no Best Offer on an auction, and the server drops the terms —
    /// so the composer must not offer them.
    func test_auction_disallowsBestOffer() {
        XCTAssertFalse(ComposerFormatChoice(format: .auction).allowsBestOffer)
        XCTAssertTrue(ComposerFormatChoice(format: .fixedPrice).allowsBestOffer)
    }

    // MARK: - Auction validation

    func test_auctionError_blankStartingBidIsValid() {
        // Blank = "start at the listing price" (the server's own fallback).
        let choice = ComposerFormatChoice(format: .auction)
        XCTAssertNil(ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter))
    }

    func test_auctionError_filledButUnparseableStartingBid() {
        let choice = ComposerFormatChoice(format: .auction, startPriceText: "abc")
        XCTAssertNotNil(
            ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter)
        )
        let zero = ComposerFormatChoice(format: .auction, startPriceText: "0")
        XCTAssertNotNil(ListingFormatValidation.error(zero, priceCents: 4200, formatter: usFormatter))
    }

    func test_auctionError_validTerms() {
        let choice = ComposerFormatChoice(
            format: .auction,
            startPriceText: "9.99",
            reservePriceText: "25",
            buyItNowText: "60",
            duration: "DAYS_5"
        )
        XCTAssertNil(ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter))
    }

    func test_auctionError_reserveBelowStartingBid() {
        let choice = ComposerFormatChoice(
            format: .auction, startPriceText: "30", reservePriceText: "20"
        )
        XCTAssertEqual(
            ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter),
            "Reserve price must be at or above the starting bid."
        )
    }

    func test_auctionError_buyItNowMustBeatTheStartingBid() {
        let equal = ComposerFormatChoice(
            format: .auction, startPriceText: "30", buyItNowText: "30"
        )
        XCTAssertEqual(
            ListingFormatValidation.error(equal, priceCents: 4200, formatter: usFormatter),
            "Buy It Now must be above the starting bid."
        )
    }

    func test_auctionError_buyItNowBelowReserve() {
        let choice = ComposerFormatChoice(
            format: .auction, startPriceText: "10", reservePriceText: "40", buyItNowText: "30"
        )
        XCTAssertEqual(
            ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter),
            "Buy It Now must be at or above the reserve price."
        )
    }

    /// A blank starting bid publishes AT the listing price, so the reserve/BIN
    /// rules have to compare against that — not skip the check and let eBay
    /// reject the offer after the seller tapped Push.
    func test_auctionError_blankStartFallsBackToTheListingPrice() {
        let choice = ComposerFormatChoice(format: .auction, buyItNowText: "30")
        XCTAssertEqual(
            ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter),
            "Buy It Now must be above the starting bid."
        )
        // With no price known yet, there's nothing to compare against and the
        // composer blocks Push on the price separately — don't double-report.
        XCTAssertNil(ListingFormatValidation.error(choice, priceCents: 0, formatter: usFormatter))
    }

    /// A comma-decimal locale must round-trip — `Double("19,99")` is nil, which
    /// would silently drop the seller's starting bid (US-1236).
    func test_auctionError_commaDecimalLocaleParses() {
        let de = CurrencyFormatter(locale: Locale(identifier: "de_DE"))
        let choice = ComposerFormatChoice(
            format: .auction, startPriceText: "19,99", buyItNowText: "10,00"
        )
        XCTAssertEqual(
            ListingFormatValidation.error(choice, priceCents: 4200, formatter: de),
            "Buy It Now must be above the starting bid."
        )
    }

    func test_auctionError_rejectsAnUnknownDuration() {
        let choice = ComposerFormatChoice(format: .auction, duration: "DAYS_99")
        XCTAssertEqual(
            ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter),
            "Pick an auction duration."
        )
    }

    // MARK: - Variation validation

    func test_variationsError_singleVariantListingIsValid() {
        let choice = ComposerFormatChoice(format: .fixedPrice, variations: nil)
        XCTAssertNil(ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter))
    }

    func test_variationsError_validMatrix() {
        let choice = matrix([variant(size: "M"), variant(size: "L", price: "45")])
        XCTAssertNil(ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter))
    }

    func test_variationsError_blankAspectValue() {
        let choice = matrix([variant(size: "M"), variant(size: "")])
        XCTAssertEqual(
            ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter),
            "Give every variant a size."
        )
    }

    /// The server drops out-of-stock rows and publishes anything under two
    /// combinations as a plain single-SKU listing. Saying so up front is the
    /// point — otherwise the seller gets a listing they didn't build and no
    /// explanation.
    func test_variationsError_needsTwoInStockVariants() {
        let outOfStock = matrix([variant(size: "M"), variant(size: "L", quantity: "0")])
        XCTAssertEqual(
            ListingFormatValidation.error(outOfStock, priceCents: 4200, formatter: usFormatter),
            "Add at least two in-stock variants, or turn off multi-variant."
        )
        let lonely = matrix([variant(size: "M")])
        XCTAssertNotNil(
            ListingFormatValidation.error(lonely, priceCents: 4200, formatter: usFormatter)
        )
    }

    /// Duplicate combinations collide on `variantSku` server-side, so eBay
    /// rejects the group — catch it in the composer.
    func test_variationsError_duplicateCombination() {
        let choice = matrix([variant(size: "M"), variant(size: "M")])
        XCTAssertEqual(
            ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter),
            "Each variant must be a different combination."
        )
    }

    func test_variationsError_unparseableVariantPrice() {
        let choice = matrix([variant(size: "M", price: "abc"), variant(size: "L")])
        XCTAssertNotNil(ListingFormatValidation.error(choice, priceCents: 4200, formatter: usFormatter))
    }

    // MARK: - Matrix ↔ column shape (mirrors the server's normalizeVariations)

    func test_payload_convertsPricesToCentsAndDropsOutOfStock() throws {
        let variations = ComposerVariations(
            specifications: ["Size"],
            variants: [
                variant(size: "M", quantity: "2", price: "42.50"),
                variant(size: "L", quantity: "1"),
                variant(size: "XL", quantity: "0", price: "50"),
            ]
        )
        let payload = try XCTUnwrap(variations.payload(formatter: usFormatter))
        XCTAssertEqual(payload.specifications, ["Size"])
        // The out-of-stock row is dropped — exactly what the server would do.
        XCTAssertEqual(payload.variants.count, 2)
        XCTAssertEqual(payload.variants[0].aspects, ["Size": "M"])
        XCTAssertEqual(payload.variants[0].quantity, 2)
        XCTAssertEqual(payload.variants[0].priceCents, 4250)
        // A blank price means "sell at the listing price" — null, not 0.
        XCTAssertNil(payload.variants[1].priceCents)
    }

    func test_payload_isNilWhenNothingIsPublishable() {
        // Fewer than two purchasable combinations is not a variation listing.
        XCTAssertNil(
            ComposerVariations(specifications: ["Size"], variants: [variant()])
                .payload(formatter: usFormatter)
        )
        // A row missing a varies-by value is dropped.
        XCTAssertNil(
            ComposerVariations(
                specifications: ["Size"], variants: [variant(size: "M"), variant(size: " ")]
            ).payload(formatter: usFormatter)
        )
    }

    func test_seededMatrix_hasTheTwoRowsEbayNeeds() {
        let seeded = ComposerVariations.seeded()
        XCTAssertEqual(seeded.specifications, ["Size"])
        XCTAssertEqual(seeded.variants.count, 2)
    }

    /// The editor seeds from the saved column and writes it back unchanged when
    /// the seller edits nothing.
    func test_matrix_roundTripsThroughTheColumn() throws {
        let saved = ListingVariationsPayload(
            specifications: ["Size", "Color"],
            variants: [
                ListingVariantPayload(
                    aspects: ["Size": "M", "Color": "Blue"], quantity: 2, priceCents: 4250
                ),
                ListingVariantPayload(aspects: ["Size": "L", "Color": "Blue"], quantity: 1),
            ]
        )
        let seeded = ComposerVariations(payload: saved)
        XCTAssertEqual(seeded.specifications, ["Size", "Color"])
        XCTAssertEqual(seeded.variants.count, 2)
        XCTAssertEqual(try XCTUnwrap(seeded.payload()), saved)
    }

    /// The composer rebuilds its dirty-check baseline on every render, minting
    /// fresh variant ids. An id-sensitive `==` would report a phantom edit
    /// immediately and permanently — blocking swipe-dismiss on an untouched
    /// composer. `id` is for `ForEach` only.
    func test_variantEquality_ignoresIdentity() {
        XCTAssertEqual(
            ComposerVariant(id: UUID(), aspects: ["Size": "M"], quantityText: "1"),
            ComposerVariant(id: UUID(), aspects: ["Size": "M"], quantityText: "1")
        )
        XCTAssertNotEqual(variant(size: "M"), variant(size: "L"))
        XCTAssertEqual(ComposerVariations.seeded(), ComposerVariations.seeded())
    }

    func test_variantQuantity_parsesWholeUnits() {
        XCTAssertEqual(variant(quantity: "3").quantity, 3)
        XCTAssertEqual(variant(quantity: " 3 ").quantity, 3)
        XCTAssertEqual(variant(quantity: "").quantity, 0)
        XCTAssertEqual(variant(quantity: "-2").quantity, 0)
    }

    // MARK: - Resume merge (US-1006 edit preservation)

    /// A transient push failure must not revert the seller's format back to the
    /// server's resolution when the composer is restored — the selector seeds
    /// from the summary, so the choice has to ride through the merge.
    func test_merging_carriesTheFormatChoice() {
        let base = summary(format: "FIXED_PRICE")
        let merged = PublishSummary.merging(
            edits(listingFormat: ComposerFormatChoice(format: .auction)), into: base
        )
        XCTAssertEqual(merged.format, "AUCTION")
        XCTAssertEqual(merged.composerFormat, .auction)
    }

    /// No format control shown (nil) → the base summary's resolution stands.
    func test_merging_noFormatEdit_keepsBase() {
        let base = summary(format: "AUCTION", auctionStartPrice: "9.99", auctionDuration: "DAYS_5")
        let merged = PublishSummary.merging(edits(), into: base)
        XCTAssertEqual(merged.format, "AUCTION")
        XCTAssertEqual(merged.auctionStartPrice, "9.99")
        XCTAssertEqual(merged.auctionDuration, "DAYS_5")
    }

    // MARK: - Write semantics

    /// A composer that never showed the control must not write the format
    /// columns — the "leave the draft alone" contract that keeps every other
    /// saveDraft caller (bulk edit, autosave) byte-identical.
    func test_composerEdits_formatDefaultsToNonWriting() {
        XCTAssertNil(edits().listingFormat)
    }

    /// `applying` mirrors `saveDraft`'s writes — it's what the composer re-seeds
    /// from after a save (and after the save that precedes a failed push), so a
    /// stale baseline would revert the seller's typed terms on "Try again".
    func test_applying_persistsAuctionTerms() {
        let choice = ComposerFormatChoice(
            format: .auction,
            startPriceText: "9.99",
            reservePriceText: "25",
            buyItNowText: "60",
            duration: "DAYS_5"
        )
        let next = ListingDraftSettings.none.applying(
            edits(listingFormat: choice), formatter: usFormatter
        )
        XCTAssertEqual(next.auctionStartPriceCents, 999)
        XCTAssertEqual(next.auctionReservePriceCents, 2500)
        XCTAssertEqual(next.auctionBuyItNowPriceCents, 6000)
        XCTAssertEqual(next.auctionDuration, "DAYS_5")
        XCTAssertNil(next.variations)
    }

    /// Switching an auction draft back to fixed price nulls its auction terms —
    /// leaving them would hand `assemblePublishContext` a starting bid to resolve
    /// the moment the seller flipped the format back.
    func test_applying_fixedPriceClearsAuctionTerms() {
        let seeded = ListingDraftSettings(
            bestOfferEnabled: false,
            autoAcceptCents: nil,
            autoDeclineCents: nil,
            scheduledPublishAt: nil,
            auctionStartPriceCents: 999,
            auctionReservePriceCents: 2500,
            auctionBuyItNowPriceCents: 6000,
            auctionDuration: "DAYS_5"
        )
        let next = seeded.applying(
            edits(listingFormat: ComposerFormatChoice(format: .fixedPrice)), formatter: usFormatter
        )
        XCTAssertNil(next.auctionStartPriceCents)
        XCTAssertNil(next.auctionReservePriceCents)
        XCTAssertNil(next.auctionBuyItNowPriceCents)
        XCTAssertNil(next.auctionDuration)
    }

    /// The mirror image: an auction can't carry a matrix (eBay has no
    /// multi-variation auction), so choosing auction clears it.
    func test_applying_auctionClearsVariations() {
        let seeded = ListingDraftSettings(
            bestOfferEnabled: false,
            autoAcceptCents: nil,
            autoDeclineCents: nil,
            scheduledPublishAt: nil,
            variations: ListingVariationsPayload(
                specifications: ["Size"],
                variants: [
                    ListingVariantPayload(aspects: ["Size": "M"], quantity: 1),
                    ListingVariantPayload(aspects: ["Size": "L"], quantity: 1),
                ]
            )
        )
        let next = seeded.applying(
            edits(listingFormat: ComposerFormatChoice(format: .auction)), formatter: usFormatter
        )
        XCTAssertNil(next.variations)
    }

    func test_applying_persistsTheMatrix() throws {
        let choice = matrix([variant(size: "M", quantity: "2", price: "42.50"), variant(size: "L")])
        let next = ListingDraftSettings.none.applying(
            edits(listingFormat: choice), formatter: usFormatter
        )
        let payload = try XCTUnwrap(next.variations)
        XCTAssertEqual(payload.variants.count, 2)
        XCTAssertEqual(payload.variants[0].priceCents, 4250)
    }

    /// nil format edit touches nothing — an unrelated save can't rewrite the
    /// draft's format or drop its matrix.
    func test_applying_nilFormatLeavesEverythingAlone() {
        let seeded = ListingDraftSettings(
            bestOfferEnabled: false,
            autoAcceptCents: nil,
            autoDeclineCents: nil,
            scheduledPublishAt: nil,
            auctionStartPriceCents: 999,
            auctionDuration: "DAYS_5"
        )
        XCTAssertEqual(seeded.applying(edits(), formatter: usFormatter), seeded)
    }
}
