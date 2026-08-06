import XCTest
@testable import GradeThread

/// US-1897 (AC5) — the iOS Listing Quality Score surface.
///
/// The score itself is computed and tested server-side
/// (`services/edge-functions/src/lib/listing-quality-score.ts`, 25 cases); AC5
/// forbids recomputing the weights here, so these tests cover exactly what the
/// app IS responsible for: decoding the server's object faithfully, mapping a
/// score to the same colour band the web uses, and ordering rows for triage.
final class ListingQualityScoreTests: XCTestCase {

    private func decode<T: Decodable>(_ json: String, as _: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: - Decoding

    func testDecodesTheServerPayload() throws {
        let score: ListingQualityScore = try decode("""
        {
          "score": 72,
          "weightCounted": 100,
          "blocked": false,
          "blockingReasons": [],
          "components": [
            {
              "key": "aspects", "label": "Item specifics", "weight": 30,
              "earned": 22, "status": "warn",
              "detail": "4 of 8 recommended specifics filled.",
              "fixSurface": "Item specifics"
            },
            {
              "key": "fulfillment", "label": "Fulfillment", "weight": 10,
              "earned": 0, "status": "unknown",
              "detail": "Business policies not synced.",
              "fixSurface": "Marketplace settings"
            }
          ],
          "topFixes": [
            { "key": "aspects", "label": "Item specifics",
              "pointsAvailable": 8, "fixSurface": "Item specifics" }
          ]
        }
        """)

        XCTAssertEqual(score.score, 72)
        XCTAssertFalse(score.blocked)
        XCTAssertEqual(score.components.count, 2)
        XCTAssertEqual(score.components.first?.key, "aspects")
        XCTAssertEqual(score.components.first?.earned, 22)
        XCTAssertEqual(score.topFixes.first?.pointsAvailable, 8)
    }

    func testUnknownComponentReadsAsNotCheckedRatherThanZero() throws {
        let score: ListingQualityScore = try decode("""
        {"score": 90, "weightCounted": 90, "blocked": false, "blockingReasons": [],
         "components": [{"key":"fulfillment","label":"Fulfillment","weight":10,
                         "earned":0,"status":"unknown","detail":"","fixSurface":""}],
         "topFixes": []}
        """)
        // The server EXCLUDES an unreadable signal from both numerator and
        // denominator; showing "0/10" here would tell the seller to fix
        // something that may already be correct.
        XCTAssertEqual(score.components.first?.pointsText, "not checked")
        XCTAssertTrue(score.isPartial, "weightCounted 90 < 100 is a partial assessment")
    }

    func testScoredComponentShowsItsPoints() throws {
        let c: QualityComponent = try decode("""
        {"key":"photos","label":"Photos","weight":25,"earned":18,"status":"warn",
         "detail":"","fixSurface":"Photos"}
        """)
        XCTAssertEqual(c.pointsText, "18/25")
    }

    func testAnUnrecognisedStatusIsUnknownNeverAPass() throws {
        // A status this app version has not shipped support for must not be
        // painted green — an unknown signal is grey and unscored, by design.
        let c: QualityComponent = try decode("""
        {"key":"future","label":"Future check","weight":5,"earned":5,
         "status":"brilliant","detail":"","fixSurface":""}
        """)
        XCTAssertEqual(c.status, .unknown)
    }

    func testFractionalEarnedDoesNotFailTheDecode() throws {
        // The wire type is a number and the server rounds only for display; a
        // fractional value must round, not throw and cost the whole preflight.
        let c: QualityComponent = try decode("""
        {"key":"title","label":"Title","weight":15,"earned":11.6,"status":"warn",
         "detail":"","fixSurface":"Title"}
        """)
        XCTAssertEqual(c.earned, 12)
    }

    func testAPartialPayloadDegradesInsteadOfThrowing() throws {
        // The score is advisory. Losing the validate decode over a reshaped
        // advisory field would cost the seller the publish, which is worse than
        // showing no score.
        let score: ListingQualityScore = try decode(#"{"score": 55}"#)
        XCTAssertEqual(score.score, 55)
        XCTAssertTrue(score.components.isEmpty)
        XCTAssertFalse(score.blocked)
    }

    func testValidateResponseWithoutAQualityScoreDecodesAsNil() throws {
        // Back-compat: an older edge omits the field. That must read as "not
        // scored" and hide the card, never as a confident zero.
        let response: ValidateResponse = try decode("""
        {"ok": true, "blockers": [], "summary": null}
        """)
        XCTAssertNil(response.qualityScore)
    }

    func testValidateResponseCarriesTheScoreWhenPresent() throws {
        let response: ValidateResponse = try decode("""
        {"ok": false, "blockers": ["Pick a leaf category"], "summary": null,
         "qualityScore": {"score": 40, "weightCounted": 100, "blocked": true,
                          "blockingReasons": ["Category is not a leaf"],
                          "components": [], "topFixes": []}}
        """)
        XCTAssertEqual(response.qualityScore?.score, 40)
        XCTAssertTrue(response.qualityScore?.blocked == true)
        XCTAssertEqual(response.qualityScore?.blockingReasons.first, "Category is not a leaf")
    }

    // MARK: - Bands (LOCKSTEP with the web's scoreBand)

    func testBandThresholdsMatchTheWeb() {
        XCTAssertEqual(QualityScoreBand(score: 100, blocked: false), .good)
        XCTAssertEqual(QualityScoreBand(score: 85, blocked: false), .good)
        XCTAssertEqual(QualityScoreBand(score: 84, blocked: false), .fair)
        XCTAssertEqual(QualityScoreBand(score: 60, blocked: false), .fair)
        XCTAssertEqual(QualityScoreBand(score: 59, blocked: false), .poor)
        XCTAssertEqual(QualityScoreBand(score: 0, blocked: false), .poor)
    }

    func testBlockedIsItsOwnBandNotMerelyPoor() {
        // The server caps a blocked listing at 40 so it sorts with the wreckage.
        // Collapsing it into `poor` would undo that distinction on screen, which
        // is the exact confusion the cap exists to prevent — and a HIGH-scoring
        // blocked listing (possible if the cap ever moves) must still read as
        // blocked rather than green.
        XCTAssertEqual(QualityScoreBand(score: 40, blocked: true), .blocked)
        XCTAssertEqual(QualityScoreBand(score: 95, blocked: true), .blocked)
        XCTAssertNotEqual(QualityScoreBand(score: 40, blocked: true),
                          QualityScoreBand(score: 40, blocked: false))
    }

    // MARK: - Summary: never-scored is not zero

    func testNilScoreYieldsNoSummary() {
        XCTAssertNil(QualityScoreSummary(score: nil, blocked: nil))
        XCTAssertNil(QualityScoreSummary(score: nil, blocked: true))
    }

    func testZeroScoreIsARealSummary() {
        // "Never scored" and "scored zero" are different facts. A zero must
        // render a real chip; only a NULL renders the em dash.
        let summary = QualityScoreSummary(score: 0, blocked: false)
        XCTAssertNotNil(summary)
        XCTAssertEqual(summary?.score, 0)
        XCTAssertEqual(summary?.band, .poor)
    }

    func testNullBlockedFlagIsNotBlocked() {
        XCTAssertEqual(QualityScoreSummary(score: 70, blocked: nil)?.blocked, false)
    }

    // MARK: - Sort ranking

    func testUnscoredRowsSinkToTheEndOfAWorstFirstSort() {
        // "We do not know" is not evidence of low quality. Floating unknowns to
        // the top would bury the listings we DO know are weak, which is the
        // entire job of this sort. Mirrors the web's qualityRankOf.
        XCTAssertEqual(QualityScoreSummary.rank(nil), Int.max)
        XCTAssertLessThan(
            QualityScoreSummary.rank(QualityScoreSummary(score: 99, blocked: false)),
            QualityScoreSummary.rank(nil)
        )
    }

    private func draft(_ id: String, score: Int?, blocked: Bool? = nil, createdAt: String) -> DraftListing {
        DraftListing(
            id: id,
            inventoryItemId: "item-\(id)",
            batchId: "batch",
            createdAt: createdAt,
            qualityScore: score,
            qualityBlocked: blocked
        )
    }

    // `DraftsLibraryStore` is @MainActor, so its nested SortOrder and its static
    // `sorted` are MainActor-isolated too. These three are annotated for that
    // reason and not for any concurrency in the test itself — the same shape the
    // rest of DraftsTests uses.
    @MainActor
    func testQualitySortPutsWorstFirstAndUnscoredLast() {
        let rows = [
            draft("a", score: 90, createdAt: "2026-07-01T00:00:00Z"),
            draft("b", score: nil, createdAt: "2026-07-02T00:00:00Z"),
            draft("c", score: 30, blocked: true, createdAt: "2026-07-03T00:00:00Z"),
            draft("d", score: 65, createdAt: "2026-07-04T00:00:00Z"),
        ]
        let sorted = DraftsLibraryStore.sorted(rows, by: .qualityLowFirst)
        XCTAssertEqual(sorted.map(\.id), ["c", "d", "a", "b"])
    }

    @MainActor
    func testQualitySortBreaksTiesByNewestSoTheOrderIsStable() {
        let rows = [
            draft("older", score: nil, createdAt: "2026-07-01T00:00:00Z"),
            draft("newer", score: nil, createdAt: "2026-07-09T00:00:00Z"),
        ]
        let sorted = DraftsLibraryStore.sorted(rows, by: .qualityLowFirst)
        XCTAssertEqual(sorted.map(\.id), ["newer", "older"],
                       "the unscored tail must have a total, stable order")
    }

    @MainActor
    func testNewestSortIsUnchangedByTheScore() {
        let rows = [
            draft("old-but-perfect", score: 100, createdAt: "2026-07-01T00:00:00Z"),
            draft("new-but-awful", score: 5, createdAt: "2026-07-09T00:00:00Z"),
        ]
        let sorted = DraftsLibraryStore.sorted(rows, by: .newest)
        XCTAssertEqual(sorted.map(\.id), ["new-but-awful", "old-but-perfect"])
    }

    // MARK: - Row decoding from the persisted columns

    func testDraftRowDecodesThePersistedScoreColumns() throws {
        let row: DraftListing = try decode("""
        {"id":"l1","inventory_item_id":"i1","quality_score":63,"quality_blocked":false}
        """)
        XCTAssertEqual(row.quality?.score, 63)
        XCTAssertEqual(row.quality?.band, .fair)
    }

    func testDraftRowWithNoScoreColumnsHasNoSummary() throws {
        // A never-scored draft (or a response from before migration 00476)
        // shows an em dash, not a zero.
        let row: DraftListing = try decode(#"{"id":"l1","inventory_item_id":"i1"}"#)
        XCTAssertNil(row.quality)
    }
}
