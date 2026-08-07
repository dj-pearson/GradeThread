import XCTest
@testable import GradeThread

/// US-1866 — the pure half of the iOS Thrift Radar surface.
///
/// These assertions are the parity contract with `src/lib/__tests__/radar-map.test.ts`:
/// the same numbers must produce the same hotness level, the same freshness
/// bucket and the same "there is no pattern here" nil on both platforms. A store
/// that reads "Busiest near you" on the web and "Quiet" in the app would be two
/// different recommendations from one dataset.
@MainActor
final class RadarScoringTests: XCTestCase {

    // MARK: - Brand weights

    private func store(
        key: String,
        brands: [(String, Int, Int)]
    ) -> RadarPersonalStore {
        RadarPersonalStore(
            key: key,
            name: key,
            topBrands: brands.map {
                RadarPersonalBrand(brand: $0.0, items: $0.1, realizedProfitCents: $0.2)
            }
        )
    }

    func testBrandWeightsRankByItemsThenProfit() {
        let weights = RadarScoring.brandWeights([
            store(key: "a", brands: [("Nike", 2, 100), ("Patagonia", 5, 10)]),
            store(key: "b", brands: [("nike", 2, 9_000)]),
        ])
        // Patagonia 5 items beats Nike's 4, even though Nike earned far more:
        // how OFTEN a brand turns up is what predicts a worthwhile store.
        XCTAssertEqual(weights.map(\.brand), ["patagonia", "nike"])
        XCTAssertEqual(weights.reduce(0) { $0 + $1.weight }, 1, accuracy: 0.0001)
    }

    func testBrandWeightsFoldCaseAndSkipEmpty() {
        let weights = RadarScoring.brandWeights([
            store(key: "a", brands: [("NIKE", 1, 0), ("  ", 9, 0)]),
            store(key: "b", brands: [("nike", 1, 0)]),
        ])
        XCTAssertEqual(weights.count, 1)
        XCTAssertEqual(weights.first?.brand, "nike")
    }

    func testBrandWeightsCapAtThree() {
        let weights = RadarScoring.brandWeights([
            store(key: "a", brands: [
                ("one", 5, 0), ("two", 4, 0), ("three", 3, 0), ("four", 2, 0),
            ]),
        ])
        XCTAssertEqual(weights.count, RadarScoring.maxWeightedBrands)
    }

    func testBrandWeightsEmptyWhenNothingSourced() {
        XCTAssertTrue(RadarScoring.brandWeights([store(key: "a", brands: [])]).isEmpty)
    }

    // MARK: - Freshness

    func testFreshnessBuckets() {
        XCTAssertEqual(RadarScoring.freshnessFactor(daysSince: 0), 1)
        XCTAssertEqual(RadarScoring.freshnessFactor(daysSince: 3), 1)
        XCTAssertEqual(RadarScoring.freshnessFactor(daysSince: 4), 0.75)
        XCTAssertEqual(RadarScoring.freshnessFactor(daysSince: 21), 0.5)
        XCTAssertEqual(RadarScoring.freshnessFactor(daysSince: 22), 0.3)
    }

    func testUnknownFreshnessIsTreatedAsOldest() {
        // An unknown is not a recommendation: it must not score like a fresh one.
        XCTAssertEqual(RadarScoring.freshnessFactor(daysSince: nil), 0.3)
        XCTAssertEqual(RadarScoring.freshnessLabel(daysSince: nil), "No recent activity")
    }

    // MARK: - Hotness

    func testBrandMatchesBoostButDoNotFilter() {
        let weights = [RadarBrandWeight(brand: "nike", weight: 1)]
        let matched = RadarVenueActivity(allScans: 8, brandScans: ["nike": 8], daysSince: 0)
        let busier = RadarVenueActivity(allScans: 10, brandScans: [:], daysSince: 0)

        XCTAssertEqual(RadarScoring.weightedActivity(matched, weights: weights), 24)
        XCTAssertEqual(RadarScoring.weightedActivity(busier, weights: weights), 10)
        // The unmatched venue is still scored — a store nobody has scanned your
        // brands at can be the busiest place in town.
        XCTAssertGreaterThan(RadarScoring.hotnessScore(busier, weights: weights, peak: 24), 0)
    }

    func testHotnessIsRelativeToThePeakInView() {
        let activity = RadarVenueActivity(allScans: 5, daysSince: 0)
        XCTAssertEqual(RadarScoring.hotnessScore(activity, weights: [], peak: 5), 1)
        XCTAssertEqual(RadarScoring.hotnessScore(activity, weights: [], peak: 10), 0.5)
        // No peak means nothing to be hotter than.
        XCTAssertEqual(RadarScoring.hotnessScore(activity, weights: [], peak: 0), 0)
    }

    func testHotnessLevelThresholdsMatchWeb() {
        XCTAssertEqual(RadarScoring.hotnessLevel(0.75), .peak)
        XCTAssertEqual(RadarScoring.hotnessLevel(0.45), .hot)
        XCTAssertEqual(RadarScoring.hotnessLevel(0.2), .warm)
        XCTAssertEqual(RadarScoring.hotnessLevel(0.19), .quiet)
    }

    // MARK: - Day of week

    func testDayBarsNilForAnAllZeroWeek() {
        // An all-zero week is a row the job has not rewritten, not a store that
        // is dead every day. Seven empty bars would read as a finding.
        XCTAssertNil(RadarScoring.dayBars([0, 0, 0, 0, 0, 0, 0]))
        XCTAssertNil(RadarScoring.dayBars([]))
        XCTAssertNil(RadarScoring.dayBars(nil))
    }

    func testDayBarsShareAgainstTheBusiestDay() {
        let bars = RadarScoring.dayBars([0, 2, 4, 0, 0, 0, 0])
        XCTAssertEqual(bars?.count, 7)
        XCTAssertEqual(bars?[2].share, 1)
        XCTAssertEqual(bars?[1].share, 0.5)
        XCTAssertEqual(bars?.filter(\.busiest).map(\.label), ["Tue"])
    }

    func testBusiestDayLabelRefusesToInventAPattern() {
        XCTAssertNil(RadarScoring.busiestDayLabel([1, 1, 1, 1, 1, 1, 1]))
        XCTAssertNil(RadarScoring.busiestDayLabel([3, 3, 3, 1, 1, 1, 1]))
        XCTAssertEqual(RadarScoring.busiestDayLabel([0, 0, 5, 0, 0, 5, 0]), "Tue and Fri")
    }

    // MARK: - Viewport

    func testBoundingBoxAroundAPointStaysWithinTheEndpointLimit() {
        let box = RadarScoring.boundingBox(around: RadarPoint(lat: 39.5, lng: -98.35))
        XCTAssertLessThanOrEqual(box.maxLat - box.minLat, RadarScoring.maxBoundingBoxDegrees)
        XCTAssertLessThanOrEqual(box.maxLng - box.minLng, RadarScoring.maxBoundingBoxDegrees)
        XCTAssertGreaterThan(box.maxLat, box.minLat)
        XCTAssertGreaterThan(box.maxLng, box.minLng)
    }

    func testLongitudeSpanWidensTowardThePoles() {
        let equator = RadarScoring.boundingBox(around: RadarPoint(lat: 0, lng: 0), radiusKm: 25)
        let north = RadarScoring.boundingBox(around: RadarPoint(lat: 60, lng: 0), radiusKm: 25)
        XCTAssertGreaterThan(north.maxLng - north.minLng, equator.maxLng - equator.minLng)
    }

    func testOversizedSpanIsShrunkNotRejected() {
        // The endpoint answers a too-wide bbox with a 400, so the client must
        // ask for less rather than for nothing.
        let wide = RadarBoundingBox(minLat: 10, minLng: 10, maxLat: 40, maxLng: 40)
        let clamped = RadarScoring.clampSpan(wide)
        XCTAssertEqual(clamped.maxLat - clamped.minLat, 5, accuracy: 0.0001)
        XCTAssertEqual((clamped.minLat + clamped.maxLat) / 2, 25, accuracy: 0.0001)
    }

    func testQuantizeSnapsOutwardOntoTheGrid() {
        let box = RadarBoundingBox(minLat: 39.512, minLng: -98.331, maxLat: 39.641, maxLng: -98.201)
        let snapped = RadarScoring.quantize(box, step: 0.05)
        XCTAssertEqual(snapped.minLat, 39.50, accuracy: 0.0001)
        XCTAssertEqual(snapped.maxLat, 39.65, accuracy: 0.0001)
        // Snapping outward never loses coverage, and it is what stops the
        // request stream being a fine-grained trace of where the user stood.
        XCTAssertLessThanOrEqual(snapped.minLat, box.minLat)
        XCTAssertGreaterThanOrEqual(snapped.maxLat, box.maxLat)
    }

    func testBoundingBoxParamIsTheShapeTheEndpointParses() {
        let box = RadarBoundingBox(minLat: 1.5, minLng: -2.25, maxLat: 3, maxLng: 4)
        XCTAssertEqual(box.param, "1.5000,-2.2500,3.0000,4.0000")
        XCTAssertEqual(box.param.split(separator: ",").count, 4)
    }

    func testBoundingBoxCoveringPointsIsNilWhenThereAreNone() {
        XCTAssertNil(RadarScoring.boundingBox(covering: []))
    }

    func testBoundingBoxCoveringPointsContainsThemAll() {
        let points = [RadarPoint(lat: 39.1, lng: -94.6), RadarPoint(lat: 39.3, lng: -94.4)]
        let box = RadarScoring.boundingBox(covering: points)
        XCTAssertNotNil(box)
        for point in points {
            XCTAssertGreaterThanOrEqual(point.lat, box!.minLat)
            XCTAssertLessThanOrEqual(point.lat, box!.maxLat)
            XCTAssertGreaterThanOrEqual(point.lng, box!.minLng)
            XCTAssertLessThanOrEqual(point.lng, box!.maxLng)
        }
    }

    func testDistanceIsRoughlyRight() {
        // One degree of latitude is ~111 km anywhere.
        let km = RadarScoring.distanceKm(
            RadarPoint(lat: 39, lng: -94),
            RadarPoint(lat: 40, lng: -94)
        )
        XCTAssertEqual(km, 111, accuracy: 2)
        XCTAssertEqual(
            RadarScoring.distanceKm(RadarPoint(lat: 1, lng: 1), RadarPoint(lat: 1, lng: 1)),
            0,
            accuracy: 0.0001
        )
    }

    // MARK: - Ranking

    func testRankPutsHotFirstAndKeepsUnscoredRows() {
        let rows = [
            RadarNearbyRow(id: "cold", name: "Cold", distanceKm: 1, score: 0.1),
            RadarNearbyRow(id: "mine", name: "Mine", distanceKm: 0.2, score: nil),
            RadarNearbyRow(id: "hot", name: "Hot", distanceKm: 20, score: 0.9),
        ]
        let ranked = RadarScoring.rank(rows)
        // Hotness first (distance only breaks ties), and the row the network
        // cannot speak about is sorted last but never dropped — that is a place
        // the reseller actually goes.
        XCTAssertEqual(ranked.map(\.id), ["hot", "cold", "mine"])
    }

    func testRankBreaksTiesByDistanceThenName() {
        let rows = [
            RadarNearbyRow(id: "b", name: "Bravo", distanceKm: 5, score: 0.5),
            RadarNearbyRow(id: "a", name: "Alpha", distanceKm: 2, score: 0.5),
            RadarNearbyRow(id: "c", name: "Charlie", distanceKm: nil, score: 0.5),
        ]
        XCTAssertEqual(RadarScoring.rank(rows).map(\.id), ["a", "b", "c"])
    }
}
