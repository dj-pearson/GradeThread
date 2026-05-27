import XCTest
import UIKit
@testable import GradeThread

@MainActor
final class PhotoIntakeTests: XCTestCase {

    // MARK: - PhotoCompressor

    func test_compress_shrinksOversizedImage() throws {
        let big = makeImage(size: CGSize(width: 4000, height: 3000))
        let output = try XCTUnwrap(PhotoCompressor.compress(big))

        // Resize step takes long edge from 4000 → 2048.
        // Thumbnail step takes long edge to 160.
        XCTAssertLessThanOrEqual(max(output.thumbnail.size.width, output.thumbnail.size.height), 160)
        // JPEG quality 0.8 on a solid-color image should land comfortably
        // under 1 MB even before generic content. The real-world ceiling
        // is the 2 MB target the AC calls out; assert against that.
        XCTAssertLessThan(output.imageData.count, 2 * 1024 * 1024)
    }

    func test_resize_leavesSmallImagesAlone() {
        let small = makeImage(size: CGSize(width: 800, height: 600))
        let resized = PhotoCompressor.resize(small, maxLongEdge: 2048)
        XCTAssertEqual(resized.size, small.size)
    }

    func test_resize_preservesAspectRatio() {
        let portrait = makeImage(size: CGSize(width: 3000, height: 4000))
        let resized = PhotoCompressor.resize(portrait, maxLongEdge: 2048)
        // Long edge clamps to 2048; short edge follows by ratio (1536).
        XCTAssertEqual(resized.size.height, 2048, accuracy: 1)
        XCTAssertEqual(resized.size.width, 1536, accuracy: 1)
    }

    // MARK: - PhotoIntakeStore

    func test_store_startsWithFrontSlotActive_andNoPhotos() {
        let store = PhotoIntakeStore()
        XCTAssertEqual(store.activeSlot, .front)
        XCTAssertTrue(store.photos.isEmpty)
        XCTAssertFalse(store.allRequiredFilled)
        XCTAssertFalse(store.hasUnsavedShots)
    }

    func test_store_recordCapture_advancesToNextEmptySlot() {
        let store = PhotoIntakeStore()
        store.recordCapture(makeCapture())
        XCTAssertEqual(store.activeSlot, .back)
        store.recordCapture(makeCapture())
        XCTAssertEqual(store.activeSlot, .tag)
        store.recordCapture(makeCapture())
        XCTAssertEqual(store.activeSlot, .detail)
        store.recordCapture(makeCapture())

        // With all required slots filled and no defects revealed, the next
        // empty slot is nil; activeSlot stays on the last-captured one.
        XCTAssertNil(store.nextEmptySlot)
        XCTAssertEqual(store.activeSlot, .detail)
        XCTAssertTrue(store.allRequiredFilled)
    }

    func test_store_revealNextDefectSlot_addsOptionalCapacity() {
        let store = PhotoIntakeStore()
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.required)

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.required + [.defect1])

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.required + [.defect1, .defect2])

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.required + PhotoSlotType.defects)

        // Fourth reveal is a no-op — there are only three defect slots.
        store.revealNextDefectSlot()
        XCTAssertFalse(store.canAddDefectSlot)
        XCTAssertEqual(store.visibleSlots.count, PhotoSlotType.required.count + 3)
    }

    func test_store_setActiveSlot_ignoresHiddenDefectSlots() {
        let store = PhotoIntakeStore()
        store.setActiveSlot(.defect1)
        // Defect slot isn't visible yet → request is ignored.
        XCTAssertEqual(store.activeSlot, .front)

        store.revealNextDefectSlot()
        store.setActiveSlot(.defect1)
        XCTAssertEqual(store.activeSlot, .defect1)
    }

    func test_store_clearPhoto_reFocusesEmptySlot() {
        let store = PhotoIntakeStore()
        store.recordCapture(makeCapture())       // front filled, active → back
        store.recordCapture(makeCapture())       // back filled, active → tag
        XCTAssertEqual(store.activeSlot, .tag)

        store.clearPhoto(at: .front)
        // Active slot already pointing at a still-empty .tag; cleared front
        // becomes the new "first empty" but we keep the current cursor.
        XCTAssertNil(store.photos[.front])
        XCTAssertEqual(store.nextEmptySlot, .front)
    }

    func test_store_hasUnsavedShots_reflectsCaptures() {
        let store = PhotoIntakeStore()
        XCTAssertFalse(store.hasUnsavedShots)
        store.recordCapture(makeCapture())
        XCTAssertTrue(store.hasUnsavedShots)
        store.reset()
        XCTAssertFalse(store.hasUnsavedShots)
        XCTAssertEqual(store.activeSlot, .front)
    }

    // MARK: - Library import (US-174)

    func test_store_setPhoto_targetsSpecificSlot_withoutAdvancingCursor() {
        let store = PhotoIntakeStore()
        let photo = makeCapture()

        store.setPhoto(photo, for: .tag)

        XCTAssertEqual(store.photos[.tag]?.id, photo.id)
        XCTAssertEqual(store.activeSlot, .front)  // cursor untouched
        XCTAssertNil(store.photos[.front])
        XCTAssertEqual(store.nextEmptySlot, .front)
    }

    func test_store_setPhoto_acrossSlots_independentOfCaptureOrder() {
        // Mirrors the library-import + camera mixed-flow: assign a library
        // photo to "Tag" first, then capture front + back. The store
        // shouldn't reshuffle anything just because they arrived in a
        // weird order.
        let store = PhotoIntakeStore()
        store.setPhoto(makeCapture(), for: .tag)
        store.recordCapture(makeCapture())   // front
        store.recordCapture(makeCapture())   // back (front filled, advances)

        XCTAssertNotNil(store.photos[.front])
        XCTAssertNotNil(store.photos[.back])
        XCTAssertNotNil(store.photos[.tag])
        XCTAssertNil(store.photos[.detail])
        XCTAssertEqual(store.nextEmptySlot, .detail)
    }

    func test_store_revealThenSetPhoto_makesDefectSlotsVisible() {
        let store = PhotoIntakeStore()
        XCTAssertFalse(store.visibleSlots.contains(.defect1))

        store.revealNextDefectSlot()
        store.setPhoto(makeCapture(), for: .defect1)

        XCTAssertTrue(store.visibleSlots.contains(.defect1))
        XCTAssertNotNil(store.photos[.defect1])
    }

    // MARK: - PhotoSlotType

    func test_slotType_serverPhotoType_collapsesDefectsToDefect() {
        XCTAssertEqual(PhotoSlotType.defect1.serverPhotoType, "defect")
        XCTAssertEqual(PhotoSlotType.defect2.serverPhotoType, "defect")
        XCTAssertEqual(PhotoSlotType.defect3.serverPhotoType, "defect")
        XCTAssertEqual(PhotoSlotType.front.serverPhotoType, "front")
        XCTAssertEqual(PhotoSlotType.tag.serverPhotoType, "tag")
    }

    func test_slotType_requiredSet_isFourCanonicalShots() {
        XCTAssertEqual(PhotoSlotType.required, [.front, .back, .tag, .detail])
        XCTAssertEqual(PhotoSlotType.required.filter { $0.isRequired }.count, 4)
        XCTAssertEqual(PhotoSlotType.defects.filter { $0.isRequired }.count, 0)
    }

    // MARK: - Helpers

    private func makeImage(size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }

    private func makeCapture() -> PhotoCapture {
        let image = makeImage(size: CGSize(width: 100, height: 100))
        let data = image.jpegData(compressionQuality: 0.5) ?? Data()
        return PhotoCapture(imageData: data, thumbnail: image)
    }
}
