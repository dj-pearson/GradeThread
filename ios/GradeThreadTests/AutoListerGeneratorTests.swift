import XCTest
@testable import GradeThread

/// Pure classify write-back resolution (`AutoListerGenerator.photoPatches`):
/// the classified cover sorts first, roles map onto `photo_type`, sensible
/// defaults fill gaps, and photos without an uploaded path are skipped.
final class AutoListerGeneratorTests: XCTestCase {

    func test_coverSortsFirst_withRoles() {
        let patches = AutoListerGenerator.photoPatches(
            coverId: "b",
            roles: ["a": "tag", "b": "front", "c": "detail"],
            orderedIds: ["a", "b", "c"],
            pathById: ["a": "pa", "b": "pb", "c": "pc"]
        )
        XCTAssertEqual(patches.map(\.storagePath), ["pb", "pa", "pc"]) // cover first
        XCTAssertEqual(patches.map(\.sortOrder), [0, 1, 2])
        XCTAssertEqual(patches[0].photoType, "front")
        XCTAssertEqual(patches[1].photoType, "tag")
    }

    func test_defaultsRoles_whenMissing() {
        let patches = AutoListerGenerator.photoPatches(
            coverId: nil,
            roles: [:],
            orderedIds: ["a", "b"],
            pathById: ["a": "pa", "b": "pb"]
        )
        XCTAssertEqual(patches.map(\.photoType), ["front", "detail"]) // cover-default, then detail
        XCTAssertEqual(patches.map(\.sortOrder), [0, 1])
    }

    func test_skipsPhotosWithoutUploadedPath() {
        let patches = AutoListerGenerator.photoPatches(
            coverId: nil,
            roles: [:],
            orderedIds: ["a", "b", "c"],
            pathById: ["a": "pa", "c": "pc"] // b never uploaded
        )
        XCTAssertEqual(patches.map(\.storagePath), ["pa", "pc"])
    }

    func test_emptyInput_returnsEmpty() {
        XCTAssertTrue(
            AutoListerGenerator.photoPatches(coverId: nil, roles: [:], orderedIds: [], pathById: [:]).isEmpty
        )
    }
}
