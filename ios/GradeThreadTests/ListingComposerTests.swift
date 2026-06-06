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
