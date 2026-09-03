import XCTest
@testable import GradeThread

/// US-3103 — one draft, several marketplaces, a price each.
///
/// The phone could copy fields into a clipboard and queue one platform at a
/// time. A seller who wanted the same jacket on Poshmark at $45 and Shopify at
/// $52 did it by hand, twice, or waited for a laptop.
///
/// What is actually being protected here is the difference between the two
/// mechanisms. An API channel is live when the call returns. An extension
/// channel is a job queued for a desktop browser that may not open for hours.
/// A sheet that called both "cross-posted" would be telling the seller
/// something false about half their listings.
@MainActor
final class CrossPushTests: XCTestCase {

    // MARK: - The blank-price rule

    func test_aBlankPriceProducesNoEntryAtAll() {
        // Blank means "use the listing price", which is the DEFAULT and the
        // common case. It must produce no key rather than an empty string the
        // route would have to interpret.
        XCTAssertNil(CrossPush.priceEntry(""))
        XCTAssertNil(CrossPush.priceEntry("   "))
        XCTAssertNil(CrossPush.priceEntry("0"))
        XCTAssertNil(CrossPush.priceEntry("-5"))
        XCTAssertNil(CrossPush.priceEntry("abc"))
    }

    func test_aTypedPriceIsNormalizedToTwoDecimals() {
        // Money in a request body someone will read in a log. "12.5" and
        // "12.50" are the same number and not the same string.
        XCTAssertEqual(CrossPush.priceEntry("45"), "45.00")
        XCTAssertEqual(CrossPush.priceEntry("12.5"), "12.50")
        XCTAssertEqual(CrossPush.priceEntry(" 52.499 "), "52.50")
    }

    // MARK: - The API request body

    func test_theBodyMatchesWhatTheWebSends() throws {
        let request = try XCTUnwrap(
            CrossPush.request(
                listingId: "L-1",
                platforms: ["shopify"],
                priceTexts: ["shopify": "52"]
            )
        )
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        // snake_case on the wire: the route reads `listing_id`, and a camelCase
        // key would be a 400 that says "listing_id is required" while the app
        // insists it sent one.
        XCTAssertEqual(json["listing_id"] as? String, "L-1")
        XCTAssertEqual(json["platforms"] as? [String], ["shopify"])
        let prices = try XCTUnwrap(json["prices"] as? [String: String])
        XCTAssertEqual(prices["shopify"], "52.00")
    }

    func test_noOverridesMeansNoPricesKey() throws {
        let request = try XCTUnwrap(
            CrossPush.request(listingId: "L-1", platforms: ["shopify"], priceTexts: [:])
        )
        XCTAssertNil(request.prices, "an empty object says the same thing with more to keep in step")

        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["prices"], "the key must be absent, not empty")
    }

    func test_onlyThePlatformsWithATypedPriceCarryOne() throws {
        let request = try XCTUnwrap(
            CrossPush.request(
                listingId: "L-1",
                platforms: ["shopify", "etsy"],
                priceTexts: ["shopify": "52", "etsy": "  "]
            )
        )
        let prices = try XCTUnwrap(request.prices)
        XCTAssertEqual(prices.count, 1)
        XCTAssertEqual(prices["shopify"], "52.00")
        XCTAssertNil(prices["etsy"])
    }

    func test_nothingSelectedBuildsNoRequest() {
        XCTAssertNil(CrossPush.request(listingId: "L-1", platforms: [], priceTexts: [:]))
    }

    // MARK: - Reading the answer

    func test_resultsAreKeyedByPlatformNotAnArray() throws {
        // The route returns Partial<Record<platform, result>>. Decoding it as an
        // array yields an empty list, which reads as "nothing happened" rather
        // than as a parse failure — so the shape is asserted directly.
        let json = #"""
        {"ok":true,"results":{
          "shopify":{"ok":true,"listing_url":"https://shop.test/p/1","price":52},
          "etsy":{"ok":false,"error":"Etsy is not connected."}
        }}
        """#
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(CrossPushResponse.self, from: Data(json.utf8))

        let outcomes = CrossPush.outcomes(requested: ["shopify", "etsy"], response: response)
        XCTAssertEqual(outcomes.count, 2)
        XCTAssertEqual(outcomes[0].state, .listed(url: "https://shop.test/p/1"))
        XCTAssertEqual(outcomes[1].state, .failed("Etsy is not connected."))
    }

    func test_aRequestedPlatformMissingFromTheAnswerIsReportedFailed() throws {
        // The seller asked for two channels and must be told about two. A row
        // missing from the results reads as "fine" if it is simply dropped.
        let response = CrossPushResponse(ok: true, results: [
            "shopify": CrossPushResultRow(ok: true, listingUrl: nil, error: nil, blockers: nil),
        ])
        let outcomes = CrossPush.outcomes(requested: ["shopify", "etsy"], response: response)
        XCTAssertEqual(outcomes.count, 2)
        guard case .failed = outcomes[1].state else {
            return XCTFail("a silent omission must not read as success")
        }
    }

    func test_aBlockerBeatsTheGenericError() {
        // A blocker is the adapter refusing BEFORE it called the marketplace,
        // and it names the fix. "Could not list" does not.
        let response = CrossPushResponse(ok: false, results: [
            "poshmark": CrossPushResultRow(
                ok: false,
                listingUrl: nil,
                error: "Push failed.",
                blockers: ["Add a size before listing on Poshmark."]
            ),
        ])
        let outcomes = CrossPush.outcomes(requested: ["poshmark"], response: response)
        XCTAssertEqual(outcomes[0].state, .failed("Add a size before listing on Poshmark."))
    }

    func test_aListedRowWithNoUrlIsStillListed() {
        let response = CrossPushResponse(ok: true, results: [
            "shopify": CrossPushResultRow(ok: true, listingUrl: nil, error: nil, blockers: nil),
        ])
        let outcomes = CrossPush.outcomes(requested: ["shopify"], response: response)
        XCTAssertEqual(outcomes[0].state, .listed(url: nil))
    }

    // MARK: - The registry split

    func test_theSplitSeparatesPublishedFromQueued() {
        // This split IS the feature. Shopify publishes server-side; Poshmark can
        // only be queued for a desktop the seller may not open for hours.
        let split = CrossListingRegistry.partition(
            selected: ["shopify", "poshmark", "mercari"]
        )
        XCTAssertEqual(split.api.map(\.id), ["shopify"])
        XCTAssertEqual(split.extensionQueued.map(\.id), ["poshmark", "mercari"])
    }

    func test_anUnselectableChannelIsNeverPushed() {
        // Depop's connector is built and unapproved; Whatnot has no integration
        // at all. Pushing either would fail at the marketplace with an error the
        // seller cannot act on, so the split drops them even if something
        // managed to select them.
        let split = CrossListingRegistry.partition(selected: ["depop", "whatnot", "shopify"])
        XCTAssertEqual(split.api.map(\.id), ["shopify"])
        XCTAssertTrue(split.extensionQueued.isEmpty)
    }

    func test_ebayIsNotACrossPushTarget() {
        // eBay has its own publish path with its own policies, specifics and
        // format — the composer this sheet is opened from. Two ways to publish
        // to eBay carrying different fields is worse than one.
        XCTAssertNil(CrossListingRegistry.channel(id: "ebay"))
    }

    func test_everyTierLabelIsRealCopy() {
        for channel in CrossListingRegistry.channels {
            XCTAssertFalse(channel.tier.label.isEmpty, "\(channel.id) has no tier label")
        }
    }
}
