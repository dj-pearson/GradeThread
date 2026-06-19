import XCTest
@testable import GradeThread

final class ListingComposerTests: XCTestCase {

    // MARK: - ListingProfit (mirrors web estimateListingProfit)

    func test_profit_basic() {
        let e = ListingProfit.estimate(price: 100, costBasis: 30)
        // fees = 100 * 0.1325 + 0.40 = 13.65
        XCTAssertEqual(e.fees, 13.65, accuracy: 0.0001)
        XCTAssertEqual(e.costs, 30, accuracy: 0.0001)
        // net = 100 - 13.65 - 30 = 56.35
        XCTAssertEqual(e.net, 56.35, accuracy: 0.0001)
        XCTAssertEqual(e.marginPct, 56.35, accuracy: 0.0001)
    }

    func test_profit_nilCost_treatedAsZero() {
        let e = ListingProfit.estimate(price: 50, costBasis: nil)
        XCTAssertEqual(e.costs, 0)
        XCTAssertEqual(e.net, 50 - (50 * 0.1325 + 0.40), accuracy: 0.0001)
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
                estimate.netCents, metrics.grossProfitThisMonth,
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
}
