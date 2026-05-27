import XCTest
@testable import GradeThread

final class EbayPublishTests: XCTestCase {

    // MARK: - ValidateResponse decoding

    func test_validateResponse_decodesOkWithSummary() throws {
        let json = #"""
        {
          "ok": true,
          "blockers": [],
          "summary": {
            "title": "Vintage Levi's 501 — 32x32",
            "description": "Classic indigo wash, light wear.",
            "condition": "USED_EXCELLENT",
            "conditionDescription": "Light fading at the knees.",
            "priceValue": "42.00",
            "currency": "USD"
          }
        }
        """#
        let parsed = try JSONDecoder().decode(ValidateResponse.self, from: Data(json.utf8))
        XCTAssertTrue(parsed.ok)
        XCTAssertTrue(parsed.blockers.isEmpty)
        XCTAssertEqual(parsed.summary?.title, "Vintage Levi's 501 — 32x32")
        XCTAssertEqual(parsed.summary?.priceValue, "42.00")
        XCTAssertEqual(parsed.summary?.currency, "USD")
        XCTAssertEqual(parsed.summary?.condition, "USED_EXCELLENT")
    }

    func test_validateResponse_decodesBlockersWithNoSummary() throws {
        let json = #"""
        {
          "ok": false,
          "blockers": ["Missing front photo", "No target price set"],
          "summary": null
        }
        """#
        let parsed = try JSONDecoder().decode(ValidateResponse.self, from: Data(json.utf8))
        XCTAssertFalse(parsed.ok)
        XCTAssertEqual(parsed.blockers, ["Missing front photo", "No target price set"])
        XCTAssertNil(parsed.summary)
    }

    // MARK: - PushResponse decoding

    func test_pushResponse_decodesSnakeCaseListingFields() throws {
        let json = #"""
        {
          "ok": true,
          "listing_id": "12345678",
          "listing_url": "https://www.ebay.com/itm/12345678",
          "offer_id": "9876",
          "sku": "S-12"
        }
        """#
        let parsed = try JSONDecoder().decode(PushResponse.self, from: Data(json.utf8))
        XCTAssertEqual(parsed.listingId, "12345678")
        XCTAssertEqual(parsed.listingURL, "https://www.ebay.com/itm/12345678")
        XCTAssertEqual(parsed.offerId, "9876")
        XCTAssertEqual(parsed.sku, "S-12")
    }

    // MARK: - PushBlockersResponse decoding

    func test_pushBlockersResponse_decoded() throws {
        let json = #"""
        {"ok": false, "blockers": ["Item missing required photo: back"]}
        """#
        let parsed = try JSONDecoder().decode(PushBlockersResponse.self, from: Data(json.utf8))
        XCTAssertFalse(parsed.ok)
        XCTAssertEqual(parsed.blockers, ["Item missing required photo: back"])
    }

    // MARK: - PriceUpdateResponse + EndListingResponse decoding

    func test_priceUpdateResponse_decoded() throws {
        let json = #"""
        {"ok": true, "listing_id": "lst-1", "price": 38.99}
        """#
        let parsed = try JSONDecoder().decode(PriceUpdateResponse.self, from: Data(json.utf8))
        XCTAssertTrue(parsed.ok)
        XCTAssertEqual(parsed.listingId, "lst-1")
        XCTAssertEqual(parsed.price, 38.99, accuracy: 0.0001)
    }

    func test_endListingResponse_decoded() throws {
        let json = #"""
        {"ok": true, "listing_id": "lst-1"}
        """#
        let parsed = try JSONDecoder().decode(EndListingResponse.self, from: Data(json.utf8))
        XCTAssertTrue(parsed.ok)
        XCTAssertEqual(parsed.listingId, "lst-1")
    }

    // MARK: - EdgeErrorBody

    func test_edgeErrorBody_messagePrefersDetailWhenPresent() throws {
        let json = #"""
        {"error": "eBay rejected the price update.", "detail": "Price must exceed cost basis."}
        """#
        let parsed = try JSONDecoder().decode(EdgeErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(parsed.message, "Price must exceed cost basis.")
    }

    func test_edgeErrorBody_messageFallsBackToErrorWhenDetailMissing() throws {
        let json = #"""
        {"error": "Connect your eBay account first."}
        """#
        let parsed = try JSONDecoder().decode(EdgeErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(parsed.message, "Connect your eBay account first.")
    }

    func test_edgeErrorBody_messageNilWhenBothMissing() throws {
        let json = "{}"
        let parsed = try JSONDecoder().decode(EdgeErrorBody.self, from: Data(json.utf8))
        XCTAssertNil(parsed.message)
    }

    // MARK: - PublishOutcome equality (smoke test)

    @MainActor
    func test_publishOutcome_equality() {
        XCTAssertEqual(PublishOutcome.noOfferId, .noOfferId)
        XCTAssertEqual(PublishOutcome.blockers(["a", "b"]), .blockers(["a", "b"]))
        XCTAssertNotEqual(PublishOutcome.failed(message: "x"), .failed(message: "y"))
    }
}
