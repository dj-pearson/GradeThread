import XCTest
@testable import GradeThread

/// US-993 — Storage URL building must never force-unwrap. A misconfigured/empty
/// base URL has to yield `nil` so the upload/storage call sites can route a
/// typed, recoverable error (`.failed` / `SyncReplayError.invalidStorageURL` /
/// `RotateError.invalidStorageURL`) instead of trapping.
final class StorageURLTests: XCTestCase {
    private let base = URL(string: "https://api.gradethread.com")!

    func test_object_buildsAuthenticatedPath() {
        let url = StorageURL.object(base: base, bucket: "item-photos", path: "u/i/front_1.jpg")
        XCTAssertEqual(
            url?.absoluteString,
            "https://api.gradethread.com/storage/v1/object/item-photos/u/i/front_1.jpg"
        )
    }

    func test_publicObject_buildsPublicPath() {
        let url = StorageURL.publicObject(base: base, bucket: "item-photos", path: "u/i/front_1.jpg")
        XCTAssertEqual(
            url?.absoluteString,
            "https://api.gradethread.com/storage/v1/object/public/item-photos/u/i/front_1.jpg"
        )
    }

    /// A nil base URL (empty/missing config) returns nil — the call sites turn
    /// this into a typed error rather than crashing.
    func test_nilBase_returnsNil() {
        XCTAssertNil(StorageURL.object(base: nil, bucket: "item-photos", path: "p.jpg"))
        XCTAssertNil(StorageURL.publicObject(base: nil, bucket: "item-photos", path: "p.jpg"))
    }
}
