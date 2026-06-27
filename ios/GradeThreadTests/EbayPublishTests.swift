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

    // US-1241: a 0/negative price is rejected before any network round-trip.
    @MainActor
    func test_updatePrice_rejectsNonPositivePriceBeforeNetwork() async {
        let service = EbayPublishService()
        for bad in [0.0, -1.0] {
            let outcome = await service.updatePrice(listingId: "L1", price: bad)
            guard case .failed = outcome else {
                XCTFail("expected .failed for price \(bad), got \(outcome)")
                continue
            }
        }
    }

    // MARK: - Edit-preservation on retry (US-1006)

    private func sampleSummary() -> PublishSummary {
        PublishSummary(
            title: "Server title",
            description: "Server description",
            condition: "USED_GOOD",
            conditionDescription: "server note",
            priceValue: "42.00",
            currency: "USD",
            aspects: nil
        )
    }

    // US-1237: brand/size are derived from the eBay aspect map so the composer's
    // comp lookup can scope by them. Tolerant of casing + blank entries.
    func test_publishSummary_brandSize_fromAspects() {
        let summary = PublishSummary(
            title: "Patagonia Better Sweater M",
            description: "desc",
            condition: "USED_GOOD",
            conditionDescription: nil,
            priceValue: "42.00",
            currency: "USD",
            aspects: ["Brand": ["  Patagonia  "], "Size": ["", "M"], "Color": ["Blue"]]
        )
        XCTAssertEqual(summary.brand, "Patagonia")
        XCTAssertEqual(summary.size, "M")

        // Missing aspects → nil (no over-broad lookup args).
        XCTAssertNil(sampleSummary().brand)
        XCTAssertNil(sampleSummary().size)
    }

    func test_publishSummaryMerging_keepsUserEdits_andBasePrice() {
        let edits = ComposerEdits(
            title: "My edited title",
            condition: .likeNew,
            conditionDescription: "  light wear at cuffs  ",
            description: "My edited description"
        )
        let merged = PublishSummary.merging(edits, into: sampleSummary())

        // User edits win for the text fields...
        XCTAssertEqual(merged.title, "My edited title")
        XCTAssertEqual(merged.description, "My edited description")
        XCTAssertEqual(merged.condition, "LIKE_NEW")
        // ...condition note is trimmed.
        XCTAssertEqual(merged.conditionDescription, "light wear at cuffs")
        // ...while price + currency stay anchored to the validated base.
        XCTAssertEqual(merged.priceValue, "42.00")
        XCTAssertEqual(merged.currency, "USD")
    }

    func test_publishSummaryMerging_inlinePriceFixWins_blankKeepsBase() {
        // US-1242: an inline price the seller typed in the composer must survive a
        // resume (Try again), overriding the (possibly zero) base price...
        let withPrice = ComposerEdits(
            title: "t", condition: .usedGood, conditionDescription: "", description: "d",
            price: "57.50"
        )
        XCTAssertEqual(PublishSummary.merging(withPrice, into: sampleSummary()).priceValue, "57.50")
        // ...while a blank inline price leaves the validated base price anchored.
        let noPrice = ComposerEdits(
            title: "t", condition: .usedGood, conditionDescription: "", description: "d"
        )
        XCTAssertEqual(PublishSummary.merging(noPrice, into: sampleSummary()).priceValue, "42.00")
    }

    func test_publishSummaryMerging_blankConditionNote_becomesNil() {
        let edits = ComposerEdits(
            title: "t",
            condition: .usedExcellent,
            conditionDescription: "   ",
            description: "d"
        )
        let merged = PublishSummary.merging(edits, into: sampleSummary())
        XCTAssertNil(merged.conditionDescription)
    }

    func test_publishSummaryMerging_roundTripsThroughComposerCondition() {
        // Every EbayCondition rawValue must resolve back to the same case so the
        // re-hydrated composer shows the user's pick, not the default.
        for option in EbayCondition.allCases {
            let edits = ComposerEdits(
                title: "t", condition: option, conditionDescription: "", description: "d"
            )
            let merged = PublishSummary.merging(edits, into: sampleSummary())
            XCTAssertEqual(EbayCondition.resolve(merged.condition), option)
        }
    }

    // MARK: - Offline classification (US-1006)

    func test_networkFailureMessage_offlineErrorIsFriendly() {
        let offline = URLError(.notConnectedToInternet)
        XCTAssertEqual(
            EbayPublishService.networkFailureMessage(offline),
            "You're offline. Check your connection and try again."
        )
    }

    func test_networkFailureMessage_nonOfflineKeepsDescription() {
        struct Boom: LocalizedError { var errorDescription: String? { "kaboom" } }
        XCTAssertEqual(EbayPublishService.networkFailureMessage(Boom()), "kaboom")
    }
}
