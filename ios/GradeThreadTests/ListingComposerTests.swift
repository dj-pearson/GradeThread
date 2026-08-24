import GradeThreadCore
import XCTest
@testable import GradeThread

final class ListingComposerTests: XCTestCase {

    // MARK: - ListingProfit (mirrors web estimateListingProfit)

    func test_profit_basic() {
        let e = ListingProfit.estimate(price: 100, costBasis: 30)
        // fees = 100 * 0.136 + 0.40 = 14.00
        XCTAssertEqual(e.fees, 14.00, accuracy: 0.0001)
        XCTAssertEqual(e.costs, 30, accuracy: 0.0001)
        // net = 100 - 14.00 - 30 = 56.00
        XCTAssertEqual(e.net, 56.00, accuracy: 0.0001)
        XCTAssertEqual(e.marginPct, 56.00, accuracy: 0.0001)
    }

    // The rate is not a free parameter: it must equal what the web and edge
    // charge against, or the same item shows two different profits depending
    // on which screen the seller is looking at -- and iOS was the optimistic
    // one for the whole time it disagreed. src/lib/ebay-fees.ts is the source.
    func test_feeRate_matchesTheSharedEbayFeeModel() {
        XCTAssertEqual(ListingProfit.defaultFeeRate, 0.136, accuracy: 0.000001)
        XCTAssertEqual(ListingProfit.defaultFixedFee, 0.40, accuracy: 0.000001)
    }

    func test_profit_nilCost_treatedAsZero() {
        let e = ListingProfit.estimate(price: 50, costBasis: nil)
        XCTAssertEqual(e.costs, 0)
        XCTAssertEqual(e.net, 50 - (50 * 0.136 + 0.40), accuracy: 0.0001)
    }

    func test_profit_zeroPrice_noFeesNoMargin() {
        let e = ListingProfit.estimate(price: 0, costBasis: 10)
        XCTAssertEqual(e.fees, 0)
        XCTAssertEqual(e.net, -10, accuracy: 0.0001)
        XCTAssertEqual(e.marginPct, 0)
    }

    func test_profit_canGoNegative() {
        let e = ListingProfit.estimate(price: 10, costBasis: 20)
        XCTAssertLessThan(e.net, 0)
        XCTAssertLessThan(e.marginPct, 0)
    }

    func test_profit_includesGradingAndShipping() {
        let e = ListingProfit.estimate(price: 100, costBasis: 20, gradingCost: 5, shippingCost: 8)
        XCTAssertEqual(e.costs, 33, accuracy: 0.0001)
    }

    func test_profit_negativeInputsClampToZero() {
        let e = ListingProfit.estimate(price: 100, costBasis: -5)
        XCTAssertEqual(e.costs, 0)
    }

    // MARK: - US-1512: Promoted Listings ad-rate disclosure

    func test_promotedAdFee_percentOfPrice_clampsNegatives() {
        XCTAssertEqual(ListingProfit.promotedAdFee(price: 100, ratePct: 8), 8, accuracy: 0.0001)
        XCTAssertEqual(ListingProfit.promotedAdFee(price: 42, ratePct: 11), 4.62, accuracy: 0.0001)
        XCTAssertEqual(ListingProfit.promotedAdFee(price: 0, ratePct: 8), 0)
        XCTAssertEqual(ListingProfit.promotedAdFee(price: -10, ratePct: 8), 0)
        XCTAssertEqual(ListingProfit.promotedAdFee(price: 100, ratePct: -3), 0)
    }

    /// US-1512 AC: the ad fee is a labeled footnote, NOT folded into the net —
    /// the estimate stays a field-for-field mirror of the web estimate.
    func test_promotedAdFee_doesNotChangeCoreEstimate() {
        let e = ListingProfit.estimate(price: 100, costBasis: 30)
        XCTAssertEqual(e.net, 56.35, accuracy: 0.0001)
    }

    func test_promotedAdRate_parse_localeAndNoise() {
        XCTAssertEqual(PromotedAdRate.parse("8"), 8)
        XCTAssertEqual(PromotedAdRate.parse(" 8.5 "), 8.5)
        XCTAssertEqual(PromotedAdRate.parse("8,5"), 8.5)   // comma-decimal keyboards
        XCTAssertEqual(PromotedAdRate.parse("8%"), 8)
        XCTAssertNil(PromotedAdRate.parse(""))
        XCTAssertNil(PromotedAdRate.parse("abc"))
        XCTAssertNil(PromotedAdRate.parse("0"))
        XCTAssertNil(PromotedAdRate.parse("-4"))
    }

    func test_promotedAdRate_parse_clampsToServerBounds() {
        // Same bounds the edge enforces (MIN/MAX_AD_RATE_PCT) — the number shown
        // must be the number applied.
        XCTAssertEqual(PromotedAdRate.parse("1"), 2)
        XCTAssertEqual(PromotedAdRate.parse("55"), 20)
    }

    func test_promotedAdRate_format_dropsIntegerNoise_keepsOneDecimal() {
        XCTAssertEqual(PromotedAdRate.format(8), "8")
        XCTAssertEqual(PromotedAdRate.format(8.5), "8.5")
        XCTAssertEqual(PromotedAdRate.format(25), "20") // clamped
    }

    // MARK: - US-1002: composer estimate ↔ Money tab parity

    /// UTC calendar + fixed `now` so the Money rollup's month filter is
    /// deterministic regardless of the runner's timezone (mirrors MoneyRollupTests).
    private let cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    private let now = Date(timeIntervalSince1970: 1_700_000_000) // mid-Nov 2023

    /// The composer's est. net profit must equal the Money tab's realized net for
    /// an equivalent completed sale, to the cent — both routed through `Money`.
    func test_composerNet_matchesMoneyTabNet_forEquivalentSale() {
        let cost = 12.34
        for price in [24.99, 50.0, 100.10, 7.77, 250.25, 19.95] {
            let estimate = ListingProfit.estimate(price: price, costBasis: cost)

            // The "equivalent completed sale": same price, fees equal to the
            // estimate's fees, the item's acquired price as cost basis, and no
            // shipping/grading/other costs.
            let item = LocalInventoryItem(id: "i", userId: "u", title: "t", status: "sold")
            item.acquiredPrice = cost
            let sale = LocalSale(
                id: "s",
                inventoryItemId: "i",
                salePrice: price,
                saleDate: now,
                platformFees: estimate.fees
            )
            let metrics = MoneyRollup.compute(items: [item], sales: [sale], now: now, calendar: cal)

            // Exact equality: both sides are `Money.cents` of the identical net.
            XCTAssertEqual(
                estimate.netCents, metrics.netProfitThisMonth,
                "composer net must equal Money tab net to the cent for price \(price)"
            )
        }
    }

    /// The cents primitive both surfaces share rounds to whole cents, half away
    /// from zero — the same `NSDecimalRound .plain` the drift-free rollups use.
    func test_moneyCents_roundsToWholeCents() {
        XCTAssertEqual(Money.cents(24.999), 25.00, accuracy: 0.0001)
        XCTAssertEqual(Money.cents(24.994), 24.99, accuracy: 0.0001)
        XCTAssertEqual(Money.cents(0.005), 0.01, accuracy: 0.0001)
        // Idempotent: re-normalizing a cents value is a no-op.
        XCTAssertEqual(Money.cents(Money.cents(24.999)), 25.00, accuracy: 0.0001)
    }

    /// The price persisted/pushed is cents-normalized — it carries no sub-cent
    /// binary-float tail (re-normalizing it is a no-op) rather than seeding a
    /// drifting listing price.
    func test_validatedListingPrice_returnsCentsExactValue() throws {
        let usd = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        let price = try ListingDraftService.validatedListingPrice("24.99", formatter: usd)
        XCTAssertEqual(price, Money.cents(price), accuracy: 0.0, "pushed price is cents-exact")
        XCTAssertEqual(price, 24.99, accuracy: 0.0001)
    }

    /// Locale inputs like "24,99" round identically across both surfaces (the
    /// composer estimate's price and the pushed listing price).
    func test_localePrice_roundsIdenticallyAcrossSurfaces() throws {
        let de = CurrencyFormatter(locale: Locale(identifier: "de_DE")) // comma decimal
        let us = CurrencyFormatter(locale: Locale(identifier: "en_US"))

        let deCents = Money.cents(try XCTUnwrap(de.parse("24,99")))
        let usCents = Money.cents(try XCTUnwrap(us.parse("24.99")))
        XCTAssertEqual(deCents, usCents, accuracy: 0.0, "comma + dot inputs normalize to the same cents")

        // The listing-price path agrees with that normalized value.
        let listingPrice = try ListingDraftService.validatedListingPrice("24,99", formatter: de)
        XCTAssertEqual(listingPrice, deCents, accuracy: 0.0)
    }

    // MARK: - ListingCopy decoding

    func test_listingCopy_decodes_ignoringExtraKeys() throws {
        let json = #"""
        {"title":"Patagonia Better Sweater Fleece Jacket Mens M",
         "description":"Excellent pre-owned condition...",
         "model":"claude-3","log_id":"abc","actions_remaining":4}
        """#
        let copy = try JSONDecoder().decode(ListingCopy.self, from: Data(json.utf8))
        XCTAssertEqual(copy.title, "Patagonia Better Sweater Fleece Jacket Mens M")
        XCTAssertTrue(copy.description.hasPrefix("Excellent"))
    }

    // MARK: - AI rewrite decoding (US-2818)

    /// `/ai/rewrite` answers in the `/extract` envelope so the web composer can
    /// reuse its review panel. iOS wants the one suggestion out of it.
    func test_rewrite_decodes_theSuggestionForTheActionsField() throws {
        let json = #"""
        {"suggestions":{"description":{"value":"Tightened copy.","confidence":0.82,
          "source":"ai:description_tighten"}},
         "condition_summary":null,"conflicts":[],"measurements":null,
         "model":"claude-3","log_id":"abc","actions_remaining":4,"ebay":null}
        """#
        let result = try ListingRewriteService.decode(
            Data(json.utf8), action: .descriptionTighten
        )
        XCTAssertEqual(result.field, .description)
        XCTAssertEqual(result.value, "Tightened copy.")
        XCTAssertEqual(result.confidence, 0.82, accuracy: 0.001)
    }

    /// Keyed on the ACTION's field, not on "whatever came back": a title
    /// suggestion answering a description rewrite must not be dropped into the
    /// description box.
    func test_rewrite_throws_whenTheEnvelopeCarriesADifferentField() {
        let json = #"""
        {"suggestions":{"title":{"value":"A title","confidence":0.9}}}
        """#
        XCTAssertThrowsError(
            try ListingRewriteService.decode(Data(json.utf8), action: .descriptionRegen)
        )
    }

    func test_rewrite_throws_onAnEmptySuggestion() {
        let json = #"""
        {"suggestions":{"description":{"value":"   ","confidence":0.4}}}
        """#
        XCTAssertThrowsError(
            try ListingRewriteService.decode(Data(json.utf8), action: .descriptionTighten)
        )
    }

    func test_rewriteAction_mapsToTheFieldItRewrites() {
        XCTAssertEqual(ListingRewriteAction.titleSeo.field, .title)
        XCTAssertEqual(ListingRewriteAction.titleShorten.field, .title)
        XCTAssertEqual(ListingRewriteAction.titleKeywords.field, .title)
        XCTAssertEqual(ListingRewriteAction.descriptionTighten.field, .description)
        XCTAssertEqual(ListingRewriteAction.descriptionRegen.field, .description)
    }
}
