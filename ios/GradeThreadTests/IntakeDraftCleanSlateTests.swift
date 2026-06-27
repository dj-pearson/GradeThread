import UIKit
import XCTest
@testable import GradeThread

/// US-1234 — clean-slate guarantees for the two intake draft stores.
///
/// Background (audit 2026-06-25): the details-first flow (`DetailsIntakeView`)
/// owns ONLY an `IntakeDraftStore` draft and the photo-first flow
/// (`PhotoIntakeView`) owns ONLY a `PhotoDraftStore` draft — they have
/// independent entry points and never co-create both drafts for one item.
/// Each flow already clears its OWN draft on save/discard, so:
///   - a completed save leaves no orphaned encrypted garment JPEGs, and
///   - clearing one store must NOT clear the other (doing so would discard a
///     user's genuinely-unsaved photos captured in a separate photo-first
///     session — the regression this story explicitly must avoid).
///
/// These tests lock in that independence so a future "clear them together"
/// change can't silently reintroduce the cross-flow data loss.
@MainActor
final class IntakeDraftCleanSlateTests: XCTestCase {

    // The on-disk directory PhotoDraftStore writes captures into. Reconstructed
    // here (it's private to the store) so we can prove no JPEGs linger after a
    // clear — `hasDraft()` reads the manifest, this proves the files are gone too.
    private var photoDraftDirectory: URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("intake-photo-draft", isDirectory: true)
    }

    /// A minimal, valid 1×1 JPEG capture so `PhotoDraftStore.save` actually
    /// writes a file to disk.
    private func makeCapture(slot: PhotoSlotType) -> PhotoCapture {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1))
        let image = renderer.image { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        let data = image.jpegData(compressionQuality: 0.8) ?? Data([0xFF, 0xD8, 0xFF])
        return PhotoCapture(imageData: data, thumbnail: image, source: .library)
    }

    /// Count of `.jpg` files currently sitting in the photo-draft directory.
    /// Returns 0 when the directory was removed (the clean-slate end state).
    private func orphanedJpegCount() -> Int {
        guard let dir = photoDraftDirectory,
              let entries = try? FileManager.default.contentsOfDirectory(
                  at: dir, includingPropertiesForKeys: nil) else { return 0 }
        return entries.filter { $0.pathExtension.lowercased() == "jpg" }.count
    }

    // MARK: - PhotoDraftStore clean slate (AC2 / AC3)

    func test_photoDraft_clearLeavesNoOrphanedJpegs() {
        PhotoDraftStore.clear()
        defer { PhotoDraftStore.clear() }

        PhotoDraftStore.save(photos: [.front: makeCapture(slot: .front),
                                      .back: makeCapture(slot: .back)])
        XCTAssertTrue(PhotoDraftStore.hasDraft(), "a saved set should be resumable")
        XCTAssertGreaterThan(orphanedJpegCount(), 0, "save should write the JPEGs to disk")

        // The save/discard paths in PhotoIntakeView call exactly this.
        PhotoDraftStore.clear()
        XCTAssertFalse(PhotoDraftStore.hasDraft(), "clear must drop the resume prompt")
        XCTAssertEqual(orphanedJpegCount(), 0, "no encrypted garment JPEGs may remain after clear")
    }

    func test_photoDraft_savingEmptySetIsACleanSlate() {
        PhotoDraftStore.clear()
        defer { PhotoDraftStore.clear() }

        PhotoDraftStore.save(photos: [.front: makeCapture(slot: .front)])
        XCTAssertTrue(PhotoDraftStore.hasDraft())

        // Saving an empty set (e.g. after every photo is deleted) overwrites the
        // single draft to nothing — no stale "resume?" prompt next launch.
        PhotoDraftStore.save(photos: [:])
        XCTAssertFalse(PhotoDraftStore.hasDraft())
        XCTAssertEqual(orphanedJpegCount(), 0)
    }

    // MARK: - The two stores are independent (AC1 — regression guard)

    /// Clearing the DETAILS draft (the details-first save path) must leave a
    /// pending PHOTO draft untouched, and vice-versa. This is why the
    /// coordinated "clear both" change was deliberately NOT made in
    /// DetailsIntakeView: the photo draft belongs to a separate, still-unsaved
    /// photo-first session and clearing it would lose the user's captures.
    func test_clearingOneDraftStore_doesNotClearTheOther() {
        IntakeDraftStore.clear()
        PhotoDraftStore.clear()
        defer {
            IntakeDraftStore.clear()
            PhotoDraftStore.clear()
        }

        let form = IntakeFormState()
        form.title = "Wool coat"
        IntakeDraftStore.save(form)
        PhotoDraftStore.save(photos: [.front: makeCapture(slot: .front)])

        XCTAssertNotNil(IntakeDraftStore.load())
        XCTAssertTrue(PhotoDraftStore.hasDraft())

        // Details-first save clears only its own draft.
        IntakeDraftStore.clear()
        XCTAssertNil(IntakeDraftStore.load())
        XCTAssertTrue(PhotoDraftStore.hasDraft(),
                      "a separate photo-first session's captures must survive a details-first save")

        // Photo-first save/discard clears only its own draft.
        PhotoDraftStore.save(photos: [.back: makeCapture(slot: .back)])
        form.title = "Denim jacket"
        IntakeDraftStore.save(form)
        PhotoDraftStore.clear()
        XCTAssertFalse(PhotoDraftStore.hasDraft())
        XCTAssertNotNil(IntakeDraftStore.load(),
                        "an in-progress details draft must survive a photo-first save/discard")
    }
}
