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

    // MARK: - US-1909: mega-group guards (mirrors web US-1550)

    func test_sequenceRun_pastTheCap_seedsSingletons_notOneMegaGroup() {
        // A no-EXIF dump is ONE contiguous filename run. Past the cap it must
        // NOT become a single boundary-free group.
        let count = PhotoGrouping.maxAutoGroupPhotos + 3
        let input = (0..<count).map { i in
            named("p\(i)", String(format: "IMG_%04d.jpg", i))
        }
        let groups = PhotoGrouping.autoGroup(input)
        XCTAssertEqual(groups.count, count, "every photo seeds its own group past the cap")
        XCTAssertTrue(groups.allSatisfy { $0.photoIds.count == 1 })
    }

    func test_sequenceRun_exactlyAtTheCap_isStillOneGroup() {
        let input = (0..<PhotoGrouping.maxAutoGroupPhotos).map { i in
            named("p\(i)", String(format: "IMG_%04d.jpg", i))
        }
        let groups = PhotoGrouping.autoGroup(input)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].photoIds.count, PhotoGrouping.maxAutoGroupPhotos)
    }

    func test_visualMerge_refusesToGrowAGroupPastTheCap() {
        // Every photo is near-identical (the same-background dump). Unbounded
        // transitive union would chain all of them into ONE group.
        let count = PhotoGrouping.maxAutoGroupPhotos + 6
        let groups = (0..<count).map { AutoGroup(photoIds: ["p\($0)"], coverId: "p\($0)") }
        let hashes = Dictionary(
            uniqueKeysWithValues: (0..<count).map { ("p\($0)", UInt64(0)) }
        )
        let merged = PhotoGrouping.mergeSimilarGroups(groups, hashes: hashes)
        XCTAssertTrue(
            merged.allSatisfy { $0.photoIds.count <= PhotoGrouping.maxAutoGroupPhotos },
            "no group may exceed the cap"
        )
        XCTAssertGreaterThan(merged.count, 1, "the dump is not chained into one group")
        XCTAssertEqual(
            merged.flatMap(\.photoIds).count, count, "no photo is dropped"
        )
    }

    func test_visualMerge_refusesAPairBeyondTheOrdinalWindow() {
        // Identical hashes, but the two groups sit far apart in shooting order —
        // a same-background false positive, not a reshoot of one garment.
        let far = PhotoGrouping.visualMergeOrdinalWindow + 2
        var groups = (0...far).map { AutoGroup(photoIds: ["p\($0)"], coverId: "p\($0)") }
        // Only the first and last hash, so the only candidate pair spans the gap.
        let hashes: [String: UInt64] = ["p0": 0, "p\(far)": 0]
        let merged = PhotoGrouping.mergeSimilarGroups(groups, hashes: hashes)
        XCTAssertEqual(merged.count, groups.count, "the out-of-window pair is refused")

        // Same hashes, now within the window → merged.
        groups = (0...PhotoGrouping.visualMergeOrdinalWindow)
            .map { AutoGroup(photoIds: ["p\($0)"], coverId: "p\($0)") }
        let near: [String: UInt64] = ["p0": 0, "p\(PhotoGrouping.visualMergeOrdinalWindow)": 0]
        XCTAssertEqual(
            PhotoGrouping.mergeSimilarGroups(groups, hashes: near).count,
            groups.count - 1
        )
    }

    func test_visualMerge_timeGapClustersAreExemptFromTheCap() {
        // A real EXIF burst may legitimately be long — the cap bounds what the
        // heuristics GROW, it never splits a time-gap cluster.
        let count = PhotoGrouping.maxAutoGroupPhotos + 5
        let input = (0..<count).map { photo("p\($0)", TimeInterval($0)) } // 1s apart
        let groups = PhotoGrouping.autoGroup(input)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].photoIds.count, count)
    }

    // MARK: - US-1909: provenance ordering

    func test_compareByProvenance_timeFirst_unknownLast() {
        let early = base
        let late = base.addingTimeInterval(100)
        XCTAssertLessThan(
            PhotoGrouping.compareByProvenance(
                capturedAt: early, sourceName: nil,
                otherCapturedAt: late, otherSourceName: nil
            ), 0
        )
        // A known time sorts before an unknown one.
        XCTAssertLessThan(
            PhotoGrouping.compareByProvenance(
                capturedAt: late, sourceName: nil,
                otherCapturedAt: nil, otherSourceName: nil
            ), 0
        )
    }

    func test_compareByProvenance_fallsBackToFilenameSequence_thenTies() {
        // Same (nil) time → filename sequence decides.
        XCTAssertLessThan(
            PhotoGrouping.compareByProvenance(
                capturedAt: nil, sourceName: "IMG_0001.jpg",
                otherCapturedAt: nil, otherSourceName: "IMG_0002.jpg"
            ), 0
        )
        // Parseable sorts before unparseable.
        XCTAssertLessThan(
            PhotoGrouping.compareByProvenance(
                capturedAt: nil, sourceName: "IMG_0001.jpg",
                otherCapturedAt: nil, otherSourceName: "front.jpg"
            ), 0
        )
        // Neither parseable → a tie, so a stable sort keeps input order.
        XCTAssertEqual(
            PhotoGrouping.compareByProvenance(
                capturedAt: nil, sourceName: "front.jpg",
                otherCapturedAt: nil, otherSourceName: "back.jpg"
            ), 0
        )
    }

    // MARK: - US-1909: sequenceRuns partitioning (direct)

    func test_sequenceRuns_partitionsContiguousRuns_omitsUnparseable() {
        let runs = PhotoGrouping.sequenceRuns([
            named("a", "IMG_0001.jpg"),
            named("b", "IMG_0002.jpg"),
            named("c", "IMG_0009.jpg"), // gap → new run
            named("x", "front.jpg"),    // unparseable → omitted entirely
        ])
        XCTAssertEqual(runs.map { $0.map(\.id) }, [["a", "b"], ["c"]])
    }

    func test_sequenceRuns_separatesPrefixes_andKeepsDuplicatesTogether() {
        let runs = PhotoGrouping.sequenceRuns([
            named("i1", "IMG_0005.jpg"),
            named("d1", "DSC_0005.jpg"),
            named("i1copy", "IMG_0005 (1).jpg"), // same seq → stays in the run
            named("i2", "IMG_0006.jpg"),
        ])
        // Sorted by (prefix, seq): dsc_ before img_.
        XCTAssertEqual(runs.map { $0.map(\.id) }, [["d1"], ["i1", "i1copy", "i2"]])
    }

    func test_sequenceRuns_emptyInput() {
        XCTAssertTrue(PhotoGrouping.sequenceRuns([]).isEmpty)
    }
}
