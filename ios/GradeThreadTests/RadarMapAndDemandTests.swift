import XCTest
@testable import GradeThread

/// US-3106 — the map, the link, and the demand strip.
///
/// Three claims, and each of them is about something that cannot be seen by
/// looking at the screen once:
///
/// 1. **The map shows what the list shows.** A pin drawn from different
///    arithmetic than the row beneath it is the app disagreeing with itself
///    about one store, and the seller has no way to tell which half is right.
/// 2. **The link body is the one the route parses.** `source_id` and `venue_id`
///    are snake_case on the wire and camelCase in Swift, and the encoder in
///    between converts. Getting that wrong produces "source_id is required" for
///    a request that plainly carries one.
/// 3. **The demand facets decode and rank.** The route answers camelCase
///    through a snake-converting decoder, which is fine and is exactly the kind
///    of fine that stops being fine silently.
@MainActor
final class RadarMapAndDemandTests: XCTestCase {

    // MARK: - Annotation mapping

    func test_everyPlacedRowBecomesAPin() {
        let pins = RadarMapPin.pins(from: [
            row(id: "a", name: "Goodwill", point: RadarPoint(lat: 40.1, lng: -111.6), score: 0.9),
            row(id: "b", name: "Savers", point: RadarPoint(lat: 40.2, lng: -111.7), score: 0.1),
        ])
        XCTAssertEqual(pins.map(\.id), ["a", "b"])
        XCTAssertEqual(pins.map(\.name), ["Goodwill", "Savers"])
    }

    func test_anUnplacedRowIsDroppedNotPlacedAtNullIsland() {
        // (0, 0) is a real point in the Gulf of Guinea, and defaulting to it is
        // the classic way an unplaced record becomes a confident pin a thousand
        // miles from anywhere.
        let pins = RadarMapPin.pins(from: [
            row(id: "mine", name: "Estate sale", point: nil),
            row(id: "placed", name: "Deseret", point: RadarPoint(lat: 40.3, lng: -111.8)),
        ])
        XCTAssertEqual(pins.map(\.id), ["placed"])
    }

    func test_thePinCarriesTheSameBandTheRowBadgeShows() {
        // Both read `RadarNearbyRow.level`, which reads RadarScoring. One
        // source, so a store cannot be amber on the list and red on the map.
        let hot = row(id: "h", name: "Hot", point: RadarPoint(lat: 1, lng: 1), score: 0.95)
        let quiet = row(id: "q", name: "Quiet", point: RadarPoint(lat: 1, lng: 1), score: 0.01)
        let pins = RadarMapPin.pins(from: [hot, quiet])
        XCTAssertEqual(pins[0].level, hot.level)
        XCTAssertEqual(pins[1].level, quiet.level)
    }

    func test_aRowWithNoNetworkDataHasNoBandButStillDraws() {
        // One of the seller's own stores, below the k-floor. Nil is not zero:
        // zero would claim we looked and found it quiet.
        let pins = RadarMapPin.pins(from: [
            row(id: "mine", name: "My shop", point: RadarPoint(lat: 2, lng: 2), score: nil)
        ])
        XCTAssertEqual(pins.count, 1)
        XCTAssertNil(pins[0].level)
    }

    func test_aStoreTheSellerHasSourcedFromIsMarkedAsTheirs() {
        let mine = RadarNearbyRow(
            id: "v1",
            venueId: "v1",
            name: "Goodwill",
            personal: RadarPersonalStore(key: "v1", name: "Goodwill", itemsSourced: 4),
            point: RadarPoint(lat: 3, lng: 3)
        )
        XCTAssertTrue(RadarMapPin.pins(from: [mine])[0].isMine)

        let visitedNeverBought = RadarNearbyRow(
            id: "v2",
            venueId: "v2",
            name: "Savers",
            personal: RadarPersonalStore(key: "v2", name: "Savers", itemsSourced: 0),
            point: RadarPoint(lat: 3, lng: 3)
        )
        XCTAssertFalse(RadarMapPin.pins(from: [visitedNeverBought])[0].isMine)
    }

    // MARK: - The region

    func test_theRegionCoversEveryPin() {
        let pins = RadarMapPin.pins(from: [
            row(id: "a", name: "A", point: RadarPoint(lat: 40.0, lng: -112.0)),
            row(id: "b", name: "B", point: RadarPoint(lat: 41.0, lng: -111.0)),
        ])
        let region = try? XCTUnwrap(RadarMapPin.region(for: pins))
        XCTAssertEqual(region?.centerLat ?? 0, 40.5, accuracy: 0.0001)
        XCTAssertEqual(region?.centerLng ?? 0, -111.5, accuracy: 0.0001)
        XCTAssertGreaterThan(region?.spanLat ?? 0, 1.0, "the span must contain both, with air")
        XCTAssertGreaterThan(region?.spanLng ?? 0, 1.0)
    }

    func test_oneStoreGetsAStreetNotARoof() {
        // A zero span renders as maximum zoom somewhere inside the building.
        let pins = RadarMapPin.pins(from: [
            row(id: "a", name: "A", point: RadarPoint(lat: 40, lng: -111))
        ])
        let region = RadarMapPin.region(for: pins)
        XCTAssertEqual(region?.spanLat, RadarMapPin.minimumSpan)
        XCTAssertEqual(region?.spanLng, RadarMapPin.minimumSpan)
    }

    func test_noPinsMeansNoRegionSoTheMapHidesItself() {
        // A map centred on nothing is a map of the Atlantic.
        XCTAssertNil(RadarMapPin.region(for: []))
    }

    // MARK: - The link body

    func test_theLinkBodyEncodesTheKeysTheRouteParses() throws {
        // `flipdeskRadarRoutes.post("/my-stores/link")` reads body.source_id and
        // body.venue_id. Swift spells them camelCase; the shared encoder
        // converts. Spelling them snake_case by hand would double-convert into
        // `source__id`.
        let data = try JSONEncoder.iso8601.encode(
            RadarLinkRequest(sourceId: "src-1", venueId: "ven-9")
        )
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(json["source_id"] as? String, "src-1")
        XCTAssertEqual(json["venue_id"] as? String, "ven-9")
        XCTAssertNil(json["sourceId"], "the camelCase spelling must not survive the encoder")
    }

    func test_unlinkingSendsNoVenueAtAll() throws {
        // Absent and explicit null both mean "unlink" to the route, and the
        // synthesized encoder omits an optional that is nil.
        let data = try JSONEncoder.iso8601.encode(
            RadarLinkRequest(sourceId: "src-1", venueId: nil)
        )
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(json["source_id"] as? String, "src-1")
        XCTAssertNil(json["venue_id"])
    }

    func test_theLinkResponseDecodes() throws {
        let json = #"{"ok":true,"venue_id":"ven-9"}"#
        let decoded = try JSONDecoder.iso8601.decode(
            RadarLinkResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertTrue(decoded.ok)
        XCTAssertEqual(decoded.venueId, "ven-9")
    }

    // MARK: - Demand facets

    func test_demandFacetsDecodeFromTheRoutesCamelCaseKeys() throws {
        // /api/flipdesk/demand answers camelCase, and the shared decoder
        // converts snake → camel. A key with no underscore passes through
        // untouched, which is why this works — and is worth pinning, because
        // "it happens to work" is not a thing anyone re-derives at review time.
        let json = """
        {
          "brands": [
            {"term":"Patagonia","wantCount":12,"topMinGrade":8.5,"topMaxPriceCents":18000}
          ],
          "categories": [
            {"term":"Fleece","wantCount":7,"topMinGrade":null,"topMaxPriceCents":null}
          ],
          "totalWants": 19
        }
        """
        let decoded = try JSONDecoder.iso8601.decode(
            DemandAggregate.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(decoded.totalWants, 19)
        XCTAssertEqual(decoded.brands.first?.term, "Patagonia")
        XCTAssertEqual(decoded.brands.first?.wantCount, 12)
        XCTAssertEqual(decoded.brands.first?.topMaxPriceCents, 18000)
        XCTAssertEqual(decoded.brands.first?.topMinGrade ?? 0, 8.5, accuracy: 0.001)
        XCTAssertNil(decoded.categories.first?.topMaxPriceCents)
    }

    func test_theStripRanksBrandsAndCategoriesTogether() {
        let aggregate = DemandAggregate(
            brands: [facet("Patagonia", 12), facet("Nike", 3)],
            categories: [facet("Fleece", 7), facet("Denim", 5)],
            totalWants: 27
        )
        XCTAssertEqual(
            aggregate.topFacets().map(\.term),
            ["Patagonia", "Fleece", "Denim", "Nike"],
            "a seller holding a garment does not think in brand-or-category"
        )
    }

    func test_theStripStopsAtEight() {
        let many = (1...20).map { facet("brand \($0)", 21 - $0) }
        XCTAssertEqual(DemandAggregate(brands: many).topFacets().count, 8)
    }

    func test_aTermThatIsBothABrandAndACategoryIsOneChip() {
        let aggregate = DemandAggregate(
            brands: [facet("Carhartt", 9)],
            categories: [facet("carhartt", 4), facet("Workwear", 6)]
        )
        XCTAssertEqual(aggregate.topFacets().map(\.term), ["Carhartt", "Workwear"])
    }

    func test_emptyAndZeroCountFacetsAreDropped() {
        let aggregate = DemandAggregate(
            brands: [facet("  ", 9), facet("Real", 0), facet("Kept", 2)]
        )
        XCTAssertEqual(aggregate.topFacets().map(\.term), ["Kept"])
    }

    func test_aBrandWinsATieWithACategory() {
        // The narrower search. A narrow search that returns something beats a
        // broad one that returns everything.
        let aggregate = DemandAggregate(
            brands: [facet("Levi's", 5)],
            categories: [facet("Jeans", 5)]
        )
        XCTAssertEqual(aggregate.topFacets().map(\.term), ["Levi's", "Jeans"])
    }

    // MARK: - The strip's own behaviour

    func test_aFailedLoadHidesTheStripRatherThanShowingAnError() async {
        // A seller standing in a shop with no signal needs the shutter button,
        // not an error about a market summary they did not ask for.
        let strip = DemandStrip(service: FailingDemand())
        await strip.loadIfNeeded()
        XCTAssertFalse(strip.isVisible)
        XCTAssertTrue(strip.facets.isEmpty)
    }

    func test_theStripLoadsOncePerScreen() async {
        // Four photos must not cost four requests for a summary that changes by
        // the day.
        let service = CountingDemand()
        let strip = DemandStrip(service: service)
        await strip.loadIfNeeded()
        await strip.loadIfNeeded()
        await strip.loadIfNeeded()
        XCTAssertEqual(service.calls, 1)
        XCTAssertTrue(strip.isVisible)
    }

    // MARK: - Fixtures

    private func row(
        id: String,
        name: String,
        point: RadarPoint?,
        score: Double? = 0.5
    ) -> RadarNearbyRow {
        RadarNearbyRow(id: id, venueId: id, name: name, score: score, point: point)
    }

    private func facet(_ term: String, _ count: Int) -> DemandFacet {
        DemandFacet(term: term, wantCount: count)
    }
}

@MainActor
private struct FailingDemand: DemandReading {
    func demand() async throws -> DemandAggregate {
        throw EdgeAPIError.network("no signal in the aisle")
    }
}

@MainActor
private final class CountingDemand: DemandReading {
    private(set) var calls = 0

    func demand() async throws -> DemandAggregate {
        calls += 1
        return DemandAggregate(
            brands: [DemandFacet(term: "Patagonia", wantCount: 3)],
            totalWants: 3
        )
    }
}
