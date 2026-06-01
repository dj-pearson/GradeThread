import XCTest
@testable import GradeThread

@MainActor
final class SalesTests: XCTestCase {

    private func decode(_ json: String) throws -> RemoteSale {
        try JSONDecoder().decode(RemoteSale.self, from: Data(json.utf8))
    }

    func test_decodesNumericAmountsAndEmbeddedTitle() throws {
        let sale = try decode(#"""
        {"id":"s1","sale_price":42.5,"platform_fees":6.4,"sale_date":"2026-05-01",
         "buyer_username":"buyer1","inventory_items":{"title":"Levi's 501"}}
        """#)
        XCTAssertEqual(sale.salePrice, 42.5)
        XCTAssertEqual(sale.platformFees, 6.4)
        XCTAssertEqual(sale.net, 36.1, accuracy: 0.001)
        XCTAssertEqual(sale.itemTitle, "Levi's 501")
        XCTAssertEqual(sale.buyerUsername, "buyer1")
    }

    /// PostgREST can return decimal columns as strings — must still parse.
    func test_decodesStringEncodedAmounts() throws {
        let sale = try decode(#"""
        {"id":"s2","sale_price":"19.99","platform_fees":"3.00",
         "sale_date":"2026-05-02T10:00:00Z","inventory_items":null}
        """#)
        XCTAssertEqual(sale.salePrice, 19.99, accuracy: 0.001)
        XCTAssertEqual(sale.platformFees, 3.0, accuracy: 0.001)
        XCTAssertNil(sale.itemTitle)
    }

    func test_dateParsing_handlesDateOnly() throws {
        let sale = try decode(#"""
        {"id":"s3","sale_price":1,"platform_fees":0,"sale_date":"2026-05-03"}
        """#)
        XCTAssertNotEqual(sale.date, .distantPast)
    }

    /// One malformed row (missing required `id`) must not blank the batch.
    func test_resilientDecode_dropsBadRows_keepsGood() {
        let json = #"""
        [
          {"id":"a","sale_price":10,"platform_fees":1,"sale_date":"2026-05-01"},
          {"sale_price":20,"platform_fees":2,"sale_date":"2026-05-02"}
        ]
        """#
        let rows = SalesStore.decodeSalesResiliently(Data(json.utf8))
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.id, "a")
    }
}
