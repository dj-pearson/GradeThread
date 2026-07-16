import XCTest
@testable import GradeThread

/// US-1909: the pure client-side windowing for the AutoLister AI passes. Ported
/// from the web `src/lib/autolister-verify-windows.ts` (US-1903) and
/// `src/lib/autolister-propose-windows.ts` (US-1904); these mirror those suites'
/// cases so the two clients can't drift.
final class AutolisterGroupWindowsTests: XCTestCase {

    // MARK: - US-1903: verify windows

    private struct Sized {
        let id: String
        let photoCount: Int
    }

    private func plan(_ counts: [Int], budget: Int = AutolisterWindows.maxVerifySamplePhotos) -> [[String]] {
        let groups = counts.enumerated().map { Sized(id: "g\($0.offset)", photoCount: $0.element) }
        return AutolisterWindows.planVerifyWindows(groups, budget: budget) { $0.photoCount }
            .map { $0.map(\.id) }
    }

    func test_sampledSizeForVerify_mirrorsTheServerSampling() {
        // First/middle/last for a big group; every photo for a small one.
        XCTAssertEqual(AutolisterWindows.sampledSizeForVerify(photoCount: 0), 0)
        XCTAssertEqual(AutolisterWindows.sampledSizeForVerify(photoCount: 1), 1)
        XCTAssertEqual(AutolisterWindows.sampledSizeForVerify(photoCount: 3), 3)
        XCTAssertEqual(AutolisterWindows.sampledSizeForVerify(photoCount: 40), 3)
        // A negative count can't consume budget.
        XCTAssertEqual(AutolisterWindows.sampledSizeForVerify(photoCount: -1), 0)
    }

    func test_planVerifyWindows_packsToTheBudget_withoutSplittingAGroup() {
        // 5 groups × 3 sampled = 15; a budget of 6 fits two groups per window.
        XCTAssertEqual(
            plan([5, 5, 5, 5, 5], budget: 6),
            [["g0", "g1"], ["g2", "g3"], ["g4"]]
        )
    }

    func test_planVerifyWindows_everythingFitsInOneWindowUnderTheBudget() {
        XCTAssertEqual(plan([3, 3, 3]), [["g0", "g1", "g2"]])
    }

    func test_planVerifyWindows_dropsEmptyGroups() {
        XCTAssertEqual(plan([3, 0, 3]), [["g0", "g2"]])
        XCTAssertTrue(plan([0, 0]).isEmpty)
        XCTAssertTrue(plan([]).isEmpty)
    }

    func test_planVerifyWindows_coversEveryGroupOfALargeSession() {
        // The US-1903 bug: a 45-group session only got its first ~13 checked.
        let counts = Array(repeating: 5, count: 45)
        let windows = plan(counts)
        XCTAssertEqual(windows.flatMap { $0 }.count, 45, "every group is covered")
        // Each window fits the server's 40-photo sample budget (3 each → 13).
        XCTAssertTrue(windows.allSatisfy { $0.count * 3 <= AutolisterWindows.maxVerifySamplePhotos })
        XCTAssertGreaterThan(windows.count, 1)
    }

    // MARK: - US-1903: suggestion dedupe

    private func suggestion(
        _ type: String,
        _ groupIds: [String],
        _ photoIds: [String] = []
    ) -> GroupVerifySuggestion {
        GroupVerifySuggestion(
            type: type, groupIds: groupIds, photoIds: photoIds,
            confidence: 0.9, reason: "r"
        )
    }

    func test_dedupe_collapsesAnUnorderedMergePair() {
        let rows = [suggestion("merge", ["a", "b"]), suggestion("merge", ["b", "a"])]
        XCTAssertEqual(AutolisterWindows.dedupeSuggestions(rows).count, 1)
        XCTAssertEqual(AutolisterWindows.dedupeSuggestions(rows)[0].groupIds, ["a", "b"],
                       "the first occurrence is kept, verbatim")
    }

    func test_dedupe_keepsMoveDirectional() {
        // A move is [from, to] — reversing it is a DIFFERENT suggestion.
        let rows = [suggestion("move", ["a", "b"], ["p"]), suggestion("move", ["b", "a"], ["p"])]
        XCTAssertEqual(AutolisterWindows.dedupeSuggestions(rows).count, 2)
    }

    func test_dedupe_photoSetIsOrderInsensitive_andDistinctSetsSurvive() {
        let rows = [
            suggestion("split", ["a"], ["p1", "p2"]),
            suggestion("split", ["a"], ["p2", "p1"]), // same set → duplicate
            suggestion("split", ["a"], ["p3"]),       // different → kept
        ]
        XCTAssertEqual(AutolisterWindows.dedupeSuggestions(rows).count, 2)
    }

    func test_dedupe_preservesFirstOccurrenceOrder() {
        let rows = [
            suggestion("merge", ["a", "b"]),
            suggestion("split", ["c"], ["p"]),
            suggestion("merge", ["b", "a"]),
        ]
        let out = AutolisterWindows.dedupeSuggestions(rows)
        XCTAssertEqual(out.map(\.type), ["merge", "split"])
    }

    // MARK: - US-1904: propose windows

    private func ids(_ n: Int) -> [String] { (0..<n).map { "p\($0)" } }

    func test_planProposeWindows_underTheCap_isOneWindow() {
        XCTAssertEqual(AutolisterWindows.planProposeWindows(ids(5), windowSize: 10), [ids(5)])
        XCTAssertTrue(AutolisterWindows.planProposeWindows([], windowSize: 10).isEmpty)
    }

    func test_planProposeWindows_overlapsAdjacentWindows() {
        // windowSize 5, overlap 2 → step 3.
        let windows = AutolisterWindows.planProposeWindows(ids(9), windowSize: 5, overlap: 2)
        XCTAssertEqual(windows, [
            ["p0", "p1", "p2", "p3", "p4"],
            ["p3", "p4", "p5", "p6", "p7"],
            ["p6", "p7", "p8"],
        ])
        // Every photo appears at least once.
        XCTAssertEqual(Set(windows.flatMap { $0 }), Set(ids(9)))
    }

    func test_planProposeWindows_alwaysProgresses_evenWithAnAbsurdOverlap() {
        // Overlap is clamped to windowSize-1, so this terminates.
        let windows = AutolisterWindows.planProposeWindows(ids(6), windowSize: 3, overlap: 99)
        XCTAssertEqual(Set(windows.flatMap { $0 }), Set(ids(6)))
        XCTAssertTrue(windows.allSatisfy { $0.count <= 3 })
    }

    // MARK: - US-1904: seam merge

    private func proposed(_ photoIds: [String], _ confidence: Double = 0.9) -> ClientProposedGroup {
        ClientProposedGroup(photoIds: photoIds, confidence: confidence, reason: "r")
    }

    func test_mergeProposalWindows_stitchesASeamSpanningItem() {
        // p3/p4 are the overlap: window 2 says they continue into p5.
        let merged = AutolisterWindows.mergeProposalWindows([
            [proposed(["p0", "p1"]), proposed(["p3", "p4"], 0.7)],
            [proposed(["p3", "p4", "p5"]), proposed(["p6", "p7"])],
        ])
        XCTAssertEqual(merged.map(\.photoIds), [["p0", "p1"], ["p3", "p4", "p5"], ["p6", "p7"]])
        XCTAssertEqual(merged[1].confidence, 0.7, "the original boundary's confidence is kept")
    }

    func test_mergeProposalWindows_dropsAGroupEntirelyInsideTheOverlap() {
        let merged = AutolisterWindows.mergeProposalWindows([
            [proposed(["p0", "p1"])],
            [proposed(["p0", "p1"])], // nothing new
        ])
        XCTAssertEqual(merged.map(\.photoIds), [["p0", "p1"]])
    }

    func test_mergeProposalWindows_neverAssignsAPhotoTwice() {
        let merged = AutolisterWindows.mergeProposalWindows([
            [proposed(["p0", "p1", "p2"])],
            [proposed(["p2", "p3"])],
            [proposed(["p3", "p4"])],
        ])
        let all = merged.flatMap(\.photoIds)
        XCTAssertEqual(all.count, Set(all).count, "no photo lands in two items")
        XCTAssertEqual(Set(all), ["p0", "p1", "p2", "p3", "p4"])
    }

    func test_mergeProposalWindows_emptyInput() {
        XCTAssertTrue(AutolisterWindows.mergeProposalWindows([]).isEmpty)
        XCTAssertTrue(AutolisterWindows.mergeProposalWindows([[]]).isEmpty)
    }
}
