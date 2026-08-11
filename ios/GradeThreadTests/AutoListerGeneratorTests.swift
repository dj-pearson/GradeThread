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

    // MARK: - Per-item upload completion (US-998)

    func test_isItemUploadComplete_falseWhenNoTasks() {
        // An item with no scheduled uploads is never "complete" — otherwise it
        // would slip past the wait as a vacuously-satisfied set.
        XCTAssertFalse(AutoListerGenerator.isItemUploadComplete([]))
    }

    func test_isItemUploadComplete_trueWhenAllTerminal() {
        let uploaded = makeTask(slot: .front, phase: .uploaded(publicURL: "https://x/y.jpg"))
        let cancelled = makeTask(slot: .back, phase: .cancelled)
        XCTAssertTrue(AutoListerGenerator.isItemUploadComplete([uploaded, cancelled]))
    }

    func test_isItemUploadComplete_falseWhilePendingOrFailed() {
        let uploaded = makeTask(slot: .front, phase: .uploaded(publicURL: "https://x/y.jpg"))
        let inflight = makeTask(slot: .back, phase: .uploading(progress: 0.4))
        XCTAssertFalse(AutoListerGenerator.isItemUploadComplete([uploaded, inflight]))

        let failed = makeTask(slot: .back, phase: .failed(error: "boom"))
        // A failed upload keeps the item pending so it counts toward a timeout
        // (and can be retried) rather than silently generating a partial set.
        XCTAssertFalse(AutoListerGenerator.isItemUploadComplete([uploaded, failed]))
    }

    // MARK: - US-2373: bulk upload progress

    @MainActor
    func test_uploadProgress_fractionCountsPhotosNotItems() {
        let progress = AutoListerGenerator.UploadProgress(
            photosDone: 60, photosTotal: 240, itemsDone: 4, itemsTotal: 40
        )
        // 4/40 items would read as 10% and sit there for minutes; photos move.
        XCTAssertEqual(progress.fraction, 0.25)
    }

    @MainActor
    func test_uploadProgress_fractionIsSafeBeforeAnythingIsScheduled() {
        let progress = AutoListerGenerator.UploadProgress(
            photosDone: 0, photosTotal: 0, itemsDone: 0, itemsTotal: 0
        )
        XCTAssertEqual(progress.fraction, 0)
    }

    /// The wait is bounded by a STALL, not by total batch time — a flat cap made
    /// any batch bigger than the cap÷(seconds per photo) fail while uploading
    /// fine, which is precisely the bulk case AutoLister is for.
    @MainActor
    func test_uploadStallTimeout_isAStallWindowNotABatchDeadline() {
        XCTAssertEqual(AutoListerGenerator.uploadStallTimeout, 90)
    }

    private func makeTask(slot: CaptureSlot, phase: PhotoUploadTask.Phase) -> PhotoUploadTask {
        PhotoUploadTask(
            inventoryItemId: "item-A",
            userId: "user-1",
            slot: slot,
            storagePath: "user-1/item-A/\(slot.serverPhotoType)_0.jpg",
            localFileURL: URL(fileURLWithPath: "/tmp/nope-\(UUID()).jpg"),
            bytes: 1024,
            phase: phase
        )
    }
}
