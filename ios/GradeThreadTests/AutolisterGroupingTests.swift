import XCTest
@testable import GradeThread

/// Pure time-gap clustering for AutoLister (`PhotoGrouping.autoGroup`). Ported
/// from the web `src/lib/autolister-grouping.ts`; covers gap boundaries,
/// capture-order sorting, cover selection, and timeless singletons.
final class AutolisterGroupingTests: XCTestCase {

    private let base = Date(timeIntervalSince1970: 1_000_000)

    private func photo(_ id: String, _ offset: TimeInterval?) -> GroupablePhoto {
        GroupablePhoto(id: id, capturedAt: offset.map { base.addingTimeInterval($0) })
    }

    func test_empty_returnsEmpty() {
        XCTAssertTrue(PhotoGrouping.autoGroup([]).isEmpty)
    }

    func test_withinGap_staysOneGroup_coverIsEarliest() {
        let groups = PhotoGrouping.autoGroup([photo("a", 0), photo("b", 10)])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].photoIds, ["a", "b"])
        XCTAssertEqual(groups[0].coverId, "a")
    }

    func test_beyondGap_splitsIntoTwoGroups() {
        let groups = PhotoGrouping.autoGroup([photo("a", 0), photo("b", 31)])
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups.map(\.coverId), ["a", "b"])
    }

    func test_exactlyAtGap_isNotASplit() {
        // Condition is strictly `> gapSeconds`, so a 30s gap stays together.
        let groups = PhotoGrouping.autoGroup([photo("a", 0), photo("b", 30)])
        XCTAssertEqual(groups.count, 1)
    }

    func test_outOfOrderInput_isSortedByCaptureTime() {
        let groups = PhotoGrouping.autoGroup([photo("b", 10), photo("a", 0)])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].photoIds, ["a", "b"])
        XCTAssertEqual(groups[0].coverId, "a")
    }

    func test_customGap_groupsLooserBursts() {
        // 45s apart: split at default 30, together at a 60s gap.
        let input = [photo("a", 0), photo("b", 45)]
        XCTAssertEqual(PhotoGrouping.autoGroup(input).count, 2)
        XCTAssertEqual(PhotoGrouping.autoGroup(input, gapSeconds: 60).count, 1)
    }

    func test_timelessPhotos_becomeSingletons() {
        let groups = PhotoGrouping.autoGroup([photo("a", nil), photo("b", nil)])
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(Set(groups.map(\.coverId)), ["a", "b"])
        XCTAssertTrue(groups.allSatisfy { $0.photoIds.count == 1 })
    }

    func test_mixedTimedAndTimeless() {
        // Two timed shots in one burst + one timeless loose photo → 2 groups.
        let groups = PhotoGrouping.autoGroup([photo("a", 0), photo("b", 5), photo("c", nil)])
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].photoIds, ["a", "b"])
        XCTAssertEqual(groups[1].photoIds, ["c"])
    }

    func test_threeDistinctBursts() {
        let groups = PhotoGrouping.autoGroup([
            photo("a", 0), photo("b", 5),      // burst 1
            photo("c", 100), photo("d", 108),  // burst 2
            photo("e", 500),                   // burst 3
        ])
        XCTAssertEqual(groups.map(\.photoIds), [["a", "b"], ["c", "d"], ["e"]])
    }
}
