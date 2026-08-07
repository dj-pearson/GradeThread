import GradeThreadCore
import XCTest
@testable import GradeThread

/// US-1871 — the Money-tab Inventory Equity card, with no network.
///
/// The cases worth having here are the ones that fail invisibly. A key-mangling
/// decoder still renders a card, just with a brand called `theNorthFace`. A
/// plan-gated response still renders a card, just an empty one where web shows
/// none. And a disclosure that drifted by a word still reads fine to a human
/// while quietly promising something the other surfaces do not.
@MainActor
final class InventoryEquityTests: XCTestCase {

    // MARK: - Fake

    private final class FakeEquityService: InventoryEquityReading {
        var payload = InventoryEquityPayload()
        var summaryError: Error?
        var trendPoints: [InventoryEquityTrendPoint] = []
        var trendError: Error?

        private(set) var summaryCalls = 0
        private(set) var trendCalls = 0

        func summary() async throws -> InventoryEquityPayload {
            summaryCalls += 1
            if let summaryError { throw summaryError }
            return payload
        }

        func trend() async throws -> InventoryEquityTrend {
            trendCalls += 1
            if let trendError { throw trendError }
            return InventoryEquityTrend(points: trendPoints)
        }
    }

    // MARK: - Decoding

    /// The route mixes conventions: camelCase fields, a snake_case pair inside
    /// `unvaluedByReason`, and breakdown maps keyed by real names. The shared
    /// EdgeAPI decoder converts keys, which is why this feature does not use it
    /// — a converted map key is a renamed brand.
    func testDecodesPayloadAndPreservesBreakdownKeysVerbatim() throws {
        let json = #"""
        {
          "currency": "USD",
          "personalSellThroughDays": 41,
          "aggregate": {
            "totalEquityCents": 128450,
            "totalLowCents": 96000,
            "totalHighCents": 160900,
            "valuedCount": 7,
            "unvaluedCount": 5,
            "unvaluedByReason": { "no_grade": 4, "no_comps": 1 },
            "byCategory": { "outerwear": { "cents": 90000, "count": 4 } },
            "byBrand": { "The North Face": { "cents": 90000, "count": 4 } },
            "byGradeBand": { "9.0-10": { "cents": 128450, "count": 7 } }
          }
        }
        """#

        let payload = try JSONDecoder().decode(
            InventoryEquityPayload.self, from: Data(json.utf8)
        )

        XCTAssertEqual(payload.currency, "USD")
        XCTAssertEqual(payload.personalSellThroughDays, 41)
        XCTAssertEqual(payload.aggregate.totalEquityCents, 128_450)
        XCTAssertEqual(payload.aggregate.totalLowCents, 96_000)
        XCTAssertEqual(payload.aggregate.totalHighCents, 160_900)
        XCTAssertEqual(payload.aggregate.valuedCount, 7)
        XCTAssertEqual(payload.aggregate.unvaluedCount, 5)
        XCTAssertEqual(payload.aggregate.unvaluedByReason.noGrade, 4)
        XCTAssertEqual(payload.aggregate.unvaluedByReason.noComps, 1)
        XCTAssertEqual(payload.aggregate.byCategory["outerwear"]?.count, 4)
        XCTAssertEqual(payload.aggregate.byBrand["The North Face"]?.cents, 90_000)
        XCTAssertEqual(payload.aggregate.byGradeBand["9.0-10"]?.cents, 128_450)
    }

    /// A key with an underscore in it survives untouched. This is the case the
    /// shared decoder would break.
    func testUnderscoredBreakdownKeySurvives() throws {
        let json = #"""
        {"aggregate":{"byBrand":{"polo_ralph_lauren":{"cents":5000,"count":2}}}}
        """#
        let payload = try JSONDecoder().decode(
            InventoryEquityPayload.self, from: Data(json.utf8)
        )
        XCTAssertEqual(payload.aggregate.byBrand["polo_ralph_lauren"]?.count, 2)
        XCTAssertNil(payload.aggregate.byBrand["poloRalphLauren"])
    }

    /// The trend route returns stored columns, so it speaks snake_case while the
    /// summary beside it speaks camelCase. Both are decoded by the same plain
    /// decoder, so the mapping has to be explicit.
    func testDecodesSnakeCaseTrendPoints() throws {
        let json = #"""
        {"currency":"USD","points":[
          {"snapshot_date":"2026-08-01","total_equity_cents":100000},
          {"snapshot_date":"2026-08-02","total_equity_cents":112500}
        ]}
        """#
        let trend = try JSONDecoder().decode(InventoryEquityTrend.self, from: Data(json.utf8))
        XCTAssertEqual(trend.points.count, 2)
        XCTAssertEqual(trend.points.first?.snapshotDate, "2026-08-01")
        XCTAssertEqual(trend.points.last?.totalEquityCents, 112_500)
    }

    /// A payload missing optional halves decodes rather than throwing — a card
    /// that fails to decode looks identical to an outage.
    func testTolerantDecodeOfSparsePayload() throws {
        let payload = try JSONDecoder().decode(
            InventoryEquityPayload.self, from: Data(#"{}"#.utf8)
        )
        XCTAssertEqual(payload.currency, "USD")
        XCTAssertNil(payload.personalSellThroughDays)
        XCTAssertEqual(payload.aggregate.totalEquityCents, 0)
        XCTAssertTrue(payload.aggregate.byBrand.isEmpty)
    }

    // MARK: - Display math

    /// Cents land on the same dollars the rest of the Money tab would compute
    /// (US-1002): rounded through ``Money``, not by a bare divide.
    func testDollarsRoundLikeMoney() {
        XCTAssertEqual(InventoryEquityMath.dollars(128_450), Money.cents(1284.50))
        XCTAssertEqual(InventoryEquityMath.dollars(0), 0)
        XCTAssertEqual(InventoryEquityMath.dollars(1), 0.01)
        XCTAssertEqual(InventoryEquityMath.dollars(-2_599), -25.99)
    }

    func testCoverageIsValuedOverTotal() {
        let aggregate = InventoryEquityAggregate(valuedCount: 7, unvaluedCount: 3)
        XCTAssertEqual(InventoryEquityMath.totalItems(aggregate), 10)
        XCTAssertEqual(InventoryEquityMath.coverage(aggregate), 0.7)
        XCTAssertEqual(InventoryEquityMath.coveragePercent(aggregate), 70)
    }

    /// An empty rack has no coverage. Reporting 0% would read as a failure to
    /// value stock that is not there.
    func testCoverageIsNilWithNoItems() {
        XCTAssertNil(InventoryEquityMath.coverage(InventoryEquityAggregate()))
        XCTAssertNil(InventoryEquityMath.coveragePercent(InventoryEquityAggregate()))
    }

    func testCoverageIsZeroWhenNothingIsValued() {
        let aggregate = InventoryEquityAggregate(valuedCount: 0, unvaluedCount: 6)
        XCTAssertEqual(InventoryEquityMath.coveragePercent(aggregate), 0)
    }

    /// Rows rank by money, cap at the limit, and share is a fraction of the
    /// largest bucket. Ties break on the label so the list cannot reshuffle
    /// between refreshes with no data change.
    func testBreakdownRowsRankAndShare() {
        let rows = InventoryEquityMath.rows(
            [
                "outerwear": InventoryEquityBucket(cents: 10_000, count: 4),
                "denim": InventoryEquityBucket(cents: 5_000, count: 2),
                "tees": InventoryEquityBucket(cents: 5_000, count: 9),
            ],
            limit: 2
        )
        XCTAssertEqual(rows.map(\.id), ["outerwear", "denim"])
        XCTAssertEqual(rows[0].label, "Outerwear")
        XCTAssertEqual(rows[0].share, 1.0)
        XCTAssertEqual(rows[1].share, 0.5)
        XCTAssertEqual(rows[1].count, 2)
    }

    func testBreakdownRowsHandleAnEmptyMap() {
        XCTAssertTrue(InventoryEquityMath.rows([:]).isEmpty)
    }

    /// A single snapshot is a reading, not a trend — the sparkline stays off.
    func testTrendChangeNeedsTwoPoints() {
        XCTAssertNil(InventoryEquityMath.trendChangeCents([]))
        XCTAssertNil(InventoryEquityMath.trendChangeCents([
            InventoryEquityTrendPoint(snapshotDate: "2026-08-01", totalEquityCents: 100)
        ]))
        XCTAssertEqual(
            InventoryEquityMath.trendChangeCents([
                InventoryEquityTrendPoint(snapshotDate: "2026-08-01", totalEquityCents: 100_000),
                InventoryEquityTrendPoint(snapshotDate: "2026-08-02", totalEquityCents: 112_500),
            ]),
            12_500
        )
    }

    // MARK: - Store

    func testLoadPublishesPayloadAndTrend() async {
        let service = FakeEquityService()
        service.payload = InventoryEquityPayload(
            aggregate: InventoryEquityAggregate(totalEquityCents: 50_000, valuedCount: 2)
        )
        service.trendPoints = [
            InventoryEquityTrendPoint(snapshotDate: "2026-08-01", totalEquityCents: 40_000),
            InventoryEquityTrendPoint(snapshotDate: "2026-08-02", totalEquityCents: 50_000),
        ]
        let store = InventoryEquityStore(service: service)

        await store.load()

        XCTAssertEqual(store.payload?.aggregate.totalEquityCents, 50_000)
        XCTAssertEqual(store.trend.count, 2)
    }

    /// The trend is a garnish. Losing it must not cost the card its number.
    func testTrendFailureKeepsTheNumber() async {
        let service = FakeEquityService()
        service.payload = InventoryEquityPayload(
            aggregate: InventoryEquityAggregate(totalEquityCents: 9_900, valuedCount: 1)
        )
        service.trendError = EdgeAPIError.network("offline")
        let store = InventoryEquityStore(service: service)

        await store.load()

        XCTAssertEqual(store.payload?.aggregate.totalEquityCents, 9_900)
        XCTAssertTrue(store.trend.isEmpty)
    }

    /// Feature switched off for the deployment: no card, matching web. An
    /// explanation of why a card is empty is worse than no card.
    func testFeatureOffRendersNothing() async {
        let service = FakeEquityService()
        service.summaryError = EdgeAPIError.notFound(detail: nil)
        let store = InventoryEquityStore(service: service)

        await store.load()

        XCTAssertEqual(store.phase, .unavailable)
        XCTAssertEqual(service.trendCalls, 0)
    }

    /// A 402 arrives as `.badRequest(detail:)` — there is no 402 case on the
    /// shared enum — and EdgeAPI has already presented the upgrade sheet, so the
    /// card goes quiet rather than showing a second wall.
    func testPlanGateIsSilent() {
        XCTAssertTrue(
            InventoryEquityStore.isSilent(.badRequest(detail: "FEATURE_LOCKED"))
        )
        XCTAssertTrue(InventoryEquityStore.isSilent(.badRequest(detail: "CAP_REACHED")))
        XCTAssertTrue(InventoryEquityStore.isSilent(.notFound(detail: "off")))
        XCTAssertFalse(InventoryEquityStore.isSilent(.network("offline")))
        XCTAssertFalse(InventoryEquityStore.isSilent(.serverError(detail: "boom")))
        XCTAssertFalse(InventoryEquityStore.isSilent(.badRequest(detail: nil)))
    }

    /// A real failure says so and offers a retry, instead of showing a $0 rack.
    func testTransportFailureIsRecoverable() async {
        let service = FakeEquityService()
        service.summaryError = EdgeAPIError.serverError(detail: "boom")
        let store = InventoryEquityStore(service: service)

        await store.load()

        guard case .failed(let message) = store.phase else {
            return XCTFail("expected a failed phase, got \(store.phase)")
        }
        XCTAssertFalse(message.isEmpty)

        service.summaryError = nil
        service.payload = InventoryEquityPayload(
            aggregate: InventoryEquityAggregate(totalEquityCents: 1_000, valuedCount: 1)
        )
        await store.refresh()
        XCTAssertEqual(store.payload?.aggregate.totalEquityCents, 1_000)
    }

    func testLoadIfNeededDoesNotRefetchAReadyCard() async {
        let service = FakeEquityService()
        let store = InventoryEquityStore(service: service)

        await store.loadIfNeeded()
        await store.loadIfNeeded()

        XCTAssertEqual(service.summaryCalls, 1)
    }

    // MARK: - Scope fence (US-1868)

    /// The disclosure is the same sentence on every surface, character for
    /// character. `src/test/inventory-equity-scope-fence.test.ts` compares this
    /// file's literal against `EQUITY_ESTIMATE_DISCLOSURE`; this case is the
    /// iOS-side half, so a drift fails here too rather than only in the web
    /// suite that an iOS change does not run.
    func testDisclosureMatchesTheSharedSentence() {
        XCTAssertEqual(
            InventoryEquityCopy.estimateDisclosure,
            "An estimate for planning only, from sold comps and your own sell-through — not an appraisal, an offer, or borrowing capacity. Items without a grade or usable comps are excluded."
        )
        XCTAssertTrue(InventoryEquityCopy.estimateDisclosure.hasPrefix("An estimate"))
        XCTAssertTrue(
            InventoryEquityCopy.estimateDisclosure.contains(
                "not an appraisal, an offer, or borrowing capacity"
            )
        )
    }
}
