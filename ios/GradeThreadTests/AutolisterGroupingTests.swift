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

    // MARK: - US-1547: filename-sequence signal (mirrors web US-1540 cases)

    private func named(_ id: String, _ name: String?, offset: TimeInterval? = nil) -> GroupablePhoto {
        GroupablePhoto(
            id: id,
            capturedAt: offset.map { base.addingTimeInterval($0) },
            sourceName: name
        )
    }

    func test_parseFilenameSequence_commonFormats_caseInsensitive() {
        XCTAssertEqual(
            PhotoGrouping.parseFilenameSequence("IMG_0551.jpg"),
            FilenameSequence(prefix: "img_", seq: 551)
        )
        XCTAssertEqual(
            PhotoGrouping.parseFilenameSequence("DSC01234.JPG"),
            FilenameSequence(prefix: "dsc", seq: 1234)
        )
        XCTAssertEqual(
            PhotoGrouping.parseFilenameSequence("IMG-20240101-WA0012.jpg"),
            FilenameSequence(prefix: "img-20240101-wa", seq: 12)
        )
        XCTAssertEqual(
            PhotoGrouping.parseFilenameSequence("PXL_20230801_103015123.jpg"),
            FilenameSequence(prefix: "pxl_20230801_", seq: 103015123)
        )
    }

    func test_parseFilenameSequence_copySuffixes_andUnusableNames() {
        XCTAssertEqual(
            PhotoGrouping.parseFilenameSequence("IMG_0551 (1).jpg"),
            FilenameSequence(prefix: "img_", seq: 551)
        )
        XCTAssertEqual(
            PhotoGrouping.parseFilenameSequence("IMG_0551 - Copy.jpg"),
            FilenameSequence(prefix: "img_", seq: 551)
        )
        XCTAssertNil(PhotoGrouping.parseFilenameSequence(nil))
        XCTAssertNil(PhotoGrouping.parseFilenameSequence("garment-front.jpg"))
    }

    func test_timelessSequenceRun_groupsInsteadOfSingletons() {
        let groups = PhotoGrouping.autoGroup([
            named("a", "IMG_0551.jpg"),
            named("b", "IMG_0552.jpg"),
            named("c", "IMG_0553.jpg"),
        ])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].photoIds, ["a", "b", "c"])
        XCTAssertEqual(groups[0].coverId, "a")
    }

    func test_sequenceGap_andPrefixChange_startNewGroups() {
        let groups = PhotoGrouping.autoGroup([
            named("a", "IMG_0001.jpg"),
            named("b", "IMG_0002.jpg"),
            named("c", "IMG_0007.jpg"), // gap → new run
            named("d", "DSC_0100.jpg"), // prefix change → new run
        ])
        // Runs come back in (prefix, seq) order: dsc_ sorts before img_.
        XCTAssertEqual(groups.map(\.photoIds), [["d"], ["a", "b"], ["c"]])
    }

    func test_duplicateFilenames_stayTogether_unparseableStaySingletons() {
        let groups = PhotoGrouping.autoGroup([
            named("a", "IMG_0001.jpg"),
            named("a2", "IMG_0001 (1).jpg"), // copy of 0001 → same run
            named("b", "IMG_0002.jpg"),
            named("x", "front.jpg"),          // unparseable → singleton
        ])
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].photoIds, ["a", "a2", "b"])
        XCTAssertEqual(groups[1].photoIds, ["x"])
    }

    func test_REGRESSION_timedPhotos_keepTimeGapBehavior_evenWithWildNames() {
        // Timed burst with out-of-sequence names: time wins, exactly as before.
        let groups = PhotoGrouping.autoGroup([
            named("t1", "IMG_0900.jpg", offset: 0),
            named("t2", "IMG_0100.jpg", offset: 5),
            named("n1", "IMG_0551.jpg"),
            named("n2", "IMG_0552.jpg"),
        ])
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].photoIds, ["t1", "t2"])
        XCTAssertEqual(groups[1].photoIds, ["n1", "n2"])
    }

    // MARK: - US-1548: dHash visual merge pass (mirrors web reconcile-cluster)

    func test_visualMerge_joinsNearIdenticalGroups() {
        // Two timed bursts far apart — same garment, near-identical hashes.
        let input = [photo("a", 0), photo("b", 500)]
        let hashes: [String: UInt64] = ["a": 0b1111, "b": 0b1110] // distance 1
        let groups = PhotoGrouping.autoGroup(input, hashes: hashes)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(Set(groups[0].photoIds), ["a", "b"])
        XCTAssertEqual(groups[0].coverId, "a") // earlier group's cover kept
    }

    func test_visualMerge_keepsDistinctItemsApart() {
        let input = [photo("a", 0), photo("b", 500)]
        let hashes: [String: UInt64] = ["a": 0, "b": UInt64.max] // distance 64
        XCTAssertEqual(PhotoGrouping.autoGroup(input, hashes: hashes).count, 2)
    }

    func test_visualMerge_isTransitive_andSkipsUnhashedPhotos() {
        let groups: [AutoGroup] = [
            AutoGroup(photoIds: ["a"], coverId: "a"),
            AutoGroup(photoIds: ["b"], coverId: "b"),
            AutoGroup(photoIds: ["c"], coverId: "c"),
            AutoGroup(photoIds: ["d"], coverId: "d"), // no hash → untouched
        ]
        // a~b and b~c → all three union; d has no hash.
        let hashes: [String: UInt64] = ["a": 0b0000, "b": 0b0001, "c": 0b0011]
        let merged = PhotoGrouping.mergeSimilarGroups(groups, hashes: hashes)
        XCTAssertEqual(merged.count, 2)
        XCTAssertEqual(Set(merged[0].photoIds), ["a", "b", "c"])
        XCTAssertEqual(merged[1].photoIds, ["d"])
    }

    func test_visualMerge_thresholdBoundary() {
        let a = AutoGroup(photoIds: ["a"], coverId: "a")
        let b = AutoGroup(photoIds: ["b"], coverId: "b")
        // Exactly 10 differing bits → merge; 11 → keep apart.
        let ten: UInt64 = (1 << 10) - 1
        let eleven: UInt64 = (1 << 11) - 1
        XCTAssertEqual(
            PhotoGrouping.mergeSimilarGroups([a, b], hashes: ["a": 0, "b": ten]).count, 1
        )
        XCTAssertEqual(
            PhotoGrouping.mergeSimilarGroups([a, b], hashes: ["a": 0, "b": eleven]).count, 2
        )
    }

    func test_dHash_hammingDistance() {
        XCTAssertEqual(DHash.hammingDistance(0, 0), 0)
        XCTAssertEqual(DHash.hammingDistance(0, UInt64.max), 64)
        XCTAssertEqual(DHash.hammingDistance(0b1010, 0b0101), 4)
    }
}
