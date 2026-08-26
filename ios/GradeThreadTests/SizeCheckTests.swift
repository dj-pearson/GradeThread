import XCTest
@testable import GradeThread

/// US-2920: the size-versus-measurements check, run against the SAME two fixture
/// cases as `services/edge-functions/src/tests/size-check_test.ts`,
/// `src/lib/size-check.test.ts` and the Android suite. Four copies of one rule
/// only stay one rule if they answer the same questions with the same numbers.
///
/// THE MOTIVATING CASE. A Lululemon men's top measuring 17.5 in pit to pit,
/// labelled Large. The brand's own chart puts a Large at a 41-43 in body chest,
/// which is a 22-26.5 in flat garment. 17.5 is below the smallest size they
/// make, so the check must fire and say so.
///
/// THE NO-FALSE-ALARM CASE. An ordinary men's tee measuring 22 in pit to pit,
/// labelled L, on the generic chart. A generic Large is exactly 22-26.5 in flat,
/// so the check must stay quiet. This is the case that keeps the feature usable:
/// a checker that cries wolf on correctly sized items gets switched off, and
/// then it catches nothing at all.
final class SizeCheckTests: XCTestCase {

    private func row(_ size: String, _ index: Int, chest: [Double]) -> SizeCheck.BandRow {
        SizeCheck.BandRow(size: size, index: index, bands: ["chest": chest])
    }

    /// What GET /api/flipdesk/size-bands returns for Lululemon men's tops.
    private var lululemonMensTops: [SizeCheck.BandRow] {
        [
            row("XS", 0, chest: [18, 22.5]),
            row("S", 1, chest: [19, 23.5]),
            row("M", 2, chest: [20.5, 25]),
            row("L", 3, chest: [22, 26.5]),
            row("XL", 4, chest: [23.5, 28]),
            row("XXL", 5, chest: [25, 29.5])
        ]
    }

    /// The generic men's alpha fallback, used when a brand has no chart.
    private var genericMensTops: [SizeCheck.BandRow] {
        [
            row("S", 0, chest: [19, 23.5]),
            row("M", 1, chest: [20.5, 25]),
            row("L", 2, chest: [22, 26.5]),
            row("XL", 3, chest: [23.5, 28]),
            row("XXL", 4, chest: [25, 29.5])
        ]
    }

    // MARK: - The two fixture cases

    func test_motivatingCase_17point5LabelledLarge_fires() {
        let rows = lululemonMensTops
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "Large"), 3)
        let verdict = SizeCheck.check(
            rows: rows, rowIndex: 3, measurements: ["chest": 17.5], tier: "brand"
        )
        XCTAssertEqual(verdict.status, .off)
        XCTAssertGreaterThanOrEqual(verdict.stepsOff, 2)
        XCTAssertEqual(verdict.impliedSize, "smaller than XS")
        XCTAssertEqual(verdict.key, "chest")
        XCTAssertEqual(verdict.expected, [22, 26.5])
    }

    func test_motivatingCase_noteNamesBothNumbers() {
        let verdict = SizeCheck.check(
            rows: lululemonMensTops, rowIndex: 3,
            measurements: ["chest": 17.5], tier: "brand"
        )
        XCTAssertEqual(
            SizeCheck.note(verdict, labelled: "Large"),
            "Measurements point to smaller than XS, not Large. "
                + "A Large usually measures 22 to 26.5 in here."
        )
    }

    func test_noFalseAlarm_real22InchLargeTee_staysQuiet() {
        let rows = genericMensTops
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "L"), 2)
        let verdict = SizeCheck.check(
            rows: rows, rowIndex: 2, measurements: ["chest": 22], tier: "generic"
        )
        XCTAssertEqual(verdict.status, .ok)
        XCTAssertEqual(verdict.stepsOff, 0)
    }

    // MARK: - Tolerance

    func test_tolerance_oneStepOnARealChart_twoOnAGenericOne() {
        XCTAssertEqual(SizeCheck.tolerance(forTier: "verified"), 1)
        XCTAssertEqual(SizeCheck.tolerance(forTier: "brand"), 1)
        XCTAssertEqual(SizeCheck.tolerance(forTier: "generic"), 2)
    }

    func test_oneStepOff_firesOnBrand_quietOnGeneric() {
        let rows = genericMensTops
        let onBrand = SizeCheck.check(
            rows: rows, rowIndex: 2, measurements: ["chest": 20.5], tier: "brand"
        )
        XCTAssertEqual(onBrand.stepsOff, 1)
        XCTAssertEqual(onBrand.status, .off)
        let onGeneric = SizeCheck.check(
            rows: rows, rowIndex: 2, measurements: ["chest": 20.5], tier: "generic"
        )
        XCTAssertEqual(onGeneric.status, .ok)
    }

    // MARK: - Label matching

    func test_resolveRow_acrossTheSpellingsSellersUse() {
        let rows = lululemonMensTops
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "Large"), 3)
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "l"), 3)
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "  L  "), 3)
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "2XL"), 5)
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "XXL"), 5)
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "extra small"), 0)
    }

    func test_resolveRow_noMatchIsNil_neverRowZero() {
        let rows = lululemonMensTops
        XCTAssertNil(SizeCheck.resolveRow(rows, size: "42R"))
        XCTAssertNil(SizeCheck.resolveRow(rows, size: ""))
        XCTAssertNil(SizeCheck.resolveRow(rows, size: nil))
    }

    func test_resolveRow_bareTwelveIsNotAUkTwelve() {
        let rows = [
            SizeCheck.BandRow(size: "UK 10 / S", index: 0, bands: ["waist": [14, 16]]),
            SizeCheck.BandRow(size: "UK 12 / M", index: 1, bands: ["waist": [15, 17]])
        ]
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "M"), 1)
        XCTAssertEqual(SizeCheck.resolveRow(rows, size: "UK 12"), 1)
        // The corpus warns that assuming a bare 12 is a UK 12 is the costliest
        // mistake on these brands.
        XCTAssertNil(SizeCheck.resolveRow(rows, size: "12"))
    }

    // MARK: - Silence

    func test_unknown_whenNothingCanBeJudged() {
        let rows = genericMensTops
        XCTAssertEqual(
            SizeCheck.check(rows: rows, rowIndex: nil,
                            measurements: ["chest": 21], tier: "brand").status,
            .unknown
        )
        XCTAssertEqual(
            SizeCheck.check(rows: rows, rowIndex: 2,
                            measurements: [:], tier: "brand").status,
            .unknown
        )
        XCTAssertEqual(
            SizeCheck.check(rows: rows, rowIndex: 2,
                            measurements: ["chest": 21], tier: "none").status,
            .unknown
        )
        XCTAssertEqual(
            SizeCheck.check(rows: [], rowIndex: 0,
                            measurements: ["chest": 21], tier: "brand").status,
            .unknown
        )
    }

    // MARK: - Copy and the one-click fix

    func test_noOneClickFix_forASizeTheBrandDoesNotMake() {
        let verdict = SizeCheck.check(
            rows: lululemonMensTops, rowIndex: 3,
            measurements: ["chest": 17.5], tier: "brand"
        )
        XCTAssertNil(SizeCheck.fixableSize(verdict))
    }

    func test_oneClickFix_offersTheImpliedSize() {
        let verdict = SizeCheck.check(
            rows: lululemonMensTops, rowIndex: 5,
            measurements: ["chest": 22.5], tier: "brand"
        )
        XCTAssertEqual(verdict.status, .off)
        XCTAssertEqual(SizeCheck.fixableSize(verdict), verdict.impliedSize)
    }

    func test_genericChartSaysOutLoudThatItIsAnEstimate() {
        XCTAssertEqual(
            SizeCheck.tierNote(tier: "generic", brand: "Lululemon"),
            "Estimate only — no Lululemon chart on file."
        )
        XCTAssertEqual(
            SizeCheck.tierNote(tier: "generic", brand: nil),
            "Estimate only — no brand chart on file."
        )
        XCTAssertNil(SizeCheck.tierNote(tier: "brand", brand: "Lululemon"))
        XCTAssertNil(SizeCheck.tierNote(tier: "verified", brand: "Lululemon"))
    }

    // MARK: - Department

    func test_department_readsMenAndWomen_refusesEverythingElse() {
        XCTAssertEqual(SizeCheck.department(fromText: ["Nike Mens Tee"]), "Men")
        XCTAssertEqual(SizeCheck.department(fromText: ["Womens Blouse"]), "Women")
        // "women" contains "men"; women must win.
        XCTAssertEqual(SizeCheck.department(fromText: ["Lululemon women's top"]), "Women")
        XCTAssertNil(SizeCheck.department(fromText: ["Plain cotton tee"]))
        XCTAssertNil(SizeCheck.department(fromText: ["Boys size 10 hoodie"]))
        XCTAssertNil(SizeCheck.department(fromText: [nil]))
    }

    // MARK: - Decoding the endpoint's response

    func test_decodesTheBandTableTheEdgeReturns() throws {
        let json = """
        {"tier":"brand","brandLabel":"Lululemon","department":"Men","garment":"Tops",
         "sourceUrl":null,"sizeSystem":"alpha","sizeClass":"standard",
         "measurementBasis":"body",
         "rows":[{"size":"XS","index":0,"bands":{"chest":[18,22.5]}}]}
        """
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(
            SizeCheck.BandsResponse.self, from: Data(json.utf8)
        )
        XCTAssertEqual(response.tier, "brand")
        XCTAssertEqual(response.brandLabel, "Lululemon")
        XCTAssertEqual(response.measurementBasis, "body")
        XCTAssertEqual(response.rows.first?.bands["chest"], [18, 22.5])
    }
}
