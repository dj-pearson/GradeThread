import XCTest
@testable import GradeThread

/// US-2533. The iOS port of the return-claim rules, tested against the SAME
/// cases as `src/test/return-analytics-claim-rules.test.ts`.
///
/// These are not cosmetic thresholds. Getting one wrong tells a paying seller
/// "your graded items return 3x less" off two sales, spins a WORSE number as a
/// win, or prints an infinity from a zero divisor - claims about our own
/// product's value, made to the person buying it. The web guard pins the rules
/// as a spec; this pins that the Swift satisfies it.
final class ReturnClaimRulesTests: XCTestCase {

    // MARK: - Fixtures

    private func stat(_ sold: Int, _ returns: Int) -> ReturnStat {
        ReturnStat(
            sold: sold,
            returns: returns,
            returnRate: sold > 0 ? Double(returns) / Double(sold) : nil
        )
    }

    private func summary(
        graded: (Int, Int),
        ungraded: (Int, Int),
        bands: [ReturnBandRow] = []
    ) -> ReturnReductionSummary {
        ReturnReductionSummary(
            overall: stat(graded.0 + ungraded.0, graded.1 + ungraded.1),
            graded: stat(graded.0, graded.1),
            ungraded: stat(ungraded.0, ungraded.1),
            bands: bands
        )
    }

    private func band(_ key: String, _ sold: Int, _ returns: Int) -> ReturnBandRow {
        ReturnBandRow(
            key: key,
            label: key.capitalized,
            sold: sold,
            returns: returns,
            returnRate: sold > 0 ? Double(returns) / Double(sold) : nil
        )
    }

    // MARK: - The sample floor

    func testFloorIsTen() {
        // Must equal MIN_RETURN_SAMPLE in src/lib/flipdesk-returns-analytics.ts.
        // A guard in the web suite reads this line to prove the two agree.
        XCTAssertEqual(ReturnClaimRules.minReturnSample, 10)
    }

    func testTinySampleYieldsNoClaimHoweverFlattering() {
        // 2 sales, 0 returns against 2 sales, 2 returns looks like an infinite win.
        XCTAssertNil(ReturnClaimRules.gradedAdvantage(summary(graded: (2, 0), ungraded: (2, 2))))
        XCTAssertNil(ReturnClaimRules.gradedAdvantage(summary(graded: (9, 1), ungraded: (50, 25))))
        XCTAssertNil(ReturnClaimRules.gradedAdvantage(summary(graded: (50, 5), ungraded: (9, 5))))
    }

    func testExactlyAtTheFloorIsEnough() {
        // The boundary earns its own case: an off-by-one here either suppresses
        // a legitimate claim or admits an illegitimate one.
        let value = ReturnClaimRules.gradedAdvantage(summary(graded: (10, 1), ungraded: (10, 5)))
        XCTAssertEqual(value ?? 0, 5, accuracy: 0.0001)
    }

    // MARK: - Never spin a worse number

    func testGradedReturningMoreYieldsNil() {
        // Returning 0.5 here would render as "graded items return 0.5x less",
        // which reads as a win and is the opposite of the truth.
        XCTAssertNil(ReturnClaimRules.gradedAdvantage(summary(graded: (100, 20), ungraded: (100, 10))))
    }

    func testATieYieldsNil() {
        XCTAssertNil(ReturnClaimRules.gradedAdvantage(summary(graded: (100, 10), ungraded: (100, 10))))
    }

    func testZeroGradedRateYieldsNilRatherThanInfinity() {
        XCTAssertNil(ReturnClaimRules.gradedAdvantage(summary(graded: (100, 0), ungraded: (100, 10))))
    }

    // MARK: - The band comparison follows the same three rules

    func testBandComparisonBelowTheFloor() {
        let s = summary(
            graded: (0, 0), ungraded: (0, 0),
            bands: [band("low", 5, 3), band("high", 50, 5)]
        )
        XCTAssertNil(ReturnClaimRules.lowVsHigh(s))
    }

    func testBandComparisonRefusesAWorseHighBand() {
        let s = summary(
            graded: (0, 0), ungraded: (0, 0),
            bands: [band("low", 100, 5), band("high", 100, 20)]
        )
        XCTAssertNil(ReturnClaimRules.lowVsHigh(s))
    }

    func testBandComparisonRefusesAZeroDivisor() {
        let s = summary(
            graded: (0, 0), ungraded: (0, 0),
            bands: [band("low", 100, 20), band("high", 100, 0)]
        )
        XCTAssertNil(ReturnClaimRules.lowVsHigh(s))
    }

    func testBandComparisonReportsARealAdvantage() {
        let s = summary(
            graded: (0, 0), ungraded: (0, 0),
            bands: [band("low", 100, 20), band("high", 100, 5)]
        )
        XCTAssertEqual(ReturnClaimRules.lowVsHigh(s)?.multiplier ?? 0, 4, accuracy: 0.0001)
    }

    func testAMissingBandYieldsNilRatherThanAPartialComparison() {
        XCTAssertNil(ReturnClaimRules.lowVsHigh(summary(graded: (100, 5), ungraded: (100, 20))))
    }

    // MARK: - Low-n marking

    func testLowSampleMarksOnlyPopulatedBandsBelowTheFloor() {
        // An EMPTY band is not "low n", it is empty - marking it would tell the
        // seller their data is unreliable when there is no data.
        XCTAssertFalse(ReturnClaimRules.isLowSample(band("low", 0, 0)))
        XCTAssertTrue(ReturnClaimRules.isLowSample(band("low", 9, 1)))
        XCTAssertFalse(ReturnClaimRules.isLowSample(band("low", 10, 1)))
    }

    // MARK: - Wire decoding

    func testDecodesTheRpcPayloadIncludingNullRates() throws {
        // The RPC sends null for a rate with nothing to divide, and the
        // difference from 0 is load-bearing: 0 means nobody returned anything.
        let json = """
        {
          "overall": {"sold": 0, "returns": 0, "returnRate": null},
          "graded": {"sold": 12, "returns": 1, "returnRate": 0.0833},
          "ungraded": {"sold": 20, "returns": 5, "returnRate": 0.25},
          "bands": [
            {"key": "low", "label": "6.0 and under", "sold": 0, "returns": 0, "returnRate": null}
          ]
        }
        """
        let decoded = try JSONDecoder().decode(
            ReturnReductionSummary.self,
            from: Data(json.utf8)
        )
        XCTAssertNil(decoded.overall.returnRate)
        XCTAssertEqual(decoded.graded.sold, 12)
        XCTAssertEqual(decoded.bands.first?.key, "low")
        XCTAssertNil(decoded.bands.first?.returnRate)
    }

    @MainActor
    func testPeriodStartIsUtcSoBothClientsAgree() {
        // A device-local formatter shifts the window by a day either side of
        // midnight for half the world, and the seller sees a different number
        // on their phone than on their laptop for the same range.
        let date = Date(timeIntervalSince1970: 1_760_000_000)
        XCTAssertEqual(ReturnReductionStore.isoDay(date), "2025-10-09")
    }
}
