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
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.defaultSlots)

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.defaultSlots + [.defect1])

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.defaultSlots + [.defect1, .defect2])

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.defaultSlots + PhotoSlotType.defects)

        // Fourth reveal is a no-op — there are only three defect slots.
        store.revealNextDefectSlot()
        XCTAssertFalse(store.canAddDefectSlot)
        XCTAssertEqual(store.visibleSlots.count, PhotoSlotType.defaultSlots.count + 3)
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

    // MARK: - Extended optional slots (web photo-type parity)

    func test_store_reveal_addsArbitraryOptionalSlot() {
        let store = PhotoIntakeStore()
        XCTAssertFalse(store.visibleSlots.contains(.flatlay))

        store.reveal(.flatlay)
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.defaultSlots + [.flatlay])

        // Re-revealing is a no-op; default slots can't be "revealed".
        store.reveal(.flatlay)
        store.reveal(.front)
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.defaultSlots + [.flatlay])
    }

    func test_store_setPhoto_autoRevealsHiddenOptionalSlot() {
        let store = PhotoIntakeStore()
        store.setPhoto(makeCapture(), for: .measurementChest)

        XCTAssertTrue(store.visibleSlots.contains(.measurementChest))
        XCTAssertNotNil(store.photos[.measurementChest])
    }

    func test_store_hiddenExtraSlots_surfacesNextDefectAndUnrevealedExtras() {
        let store = PhotoIntakeStore()
        // Only the FIRST hidden defect is offered (defects reveal in order).
        XCTAssertEqual(store.hiddenExtraSlots.first, .defect1)
        XCTAssertFalse(store.hiddenExtraSlots.contains(.defect2))
        XCTAssertTrue(store.hiddenExtraSlots.contains(.tag2))
        XCTAssertTrue(store.hiddenExtraSlots.contains(.measurementInseam))

        store.reveal(.defect1)
        store.reveal(.tag2)
        XCTAssertEqual(store.hiddenExtraSlots.first, .defect2)
        XCTAssertFalse(store.hiddenExtraSlots.contains(.tag2))
    }

    func test_store_reset_clearsRevealedExtraSlots() {
        let store = PhotoIntakeStore()
        store.reveal(.interior)
        store.revealNextDefectSlot()
        store.reset()
        XCTAssertEqual(store.visibleSlots, PhotoSlotType.defaultSlots)
    }

    // MARK: - PhotoSlotType

    func test_slotType_serverPhotoType_collapsesDefectsToDefect() {
        XCTAssertEqual(PhotoSlotType.defect1.serverPhotoType, "defect")
        XCTAssertEqual(PhotoSlotType.defect2.serverPhotoType, "defect")
        XCTAssertEqual(PhotoSlotType.defect3.serverPhotoType, "defect")
        XCTAssertEqual(PhotoSlotType.front.serverPhotoType, "front")
        XCTAssertEqual(PhotoSlotType.tag.serverPhotoType, "tag")
    }

    func test_slotType_defaultSlots_areFourCanonicalShots_onlyFrontBackBlock() {
        // The strip still defaults to the four canonical shots…
        XCTAssertEqual(PhotoSlotType.defaultSlots, [.front, .back, .tag, .detail])
        // …but only Front + Back are required (block continue/grade). Tag +
        // Detail are shown yet skippable.
        XCTAssertEqual(PhotoSlotType.required, [.front, .back])
        XCTAssertEqual(PhotoSlotType.defaultSlots.filter { $0.isRequired }, [.front, .back])
        XCTAssertEqual(PhotoSlotType.defects.filter { $0.isRequired }.count, 0)
        XCTAssertEqual(PhotoSlotType.extras.filter { $0.isRequired }.count, 0)
        XCTAssertEqual(PhotoSlotType.measurements.filter { $0.isRequired }.count, 0)
    }

    // The AI extract gates on required-OR-tag: the tag is where brand and size
    // are actually printed, and because it was merely OPTIONAL the request was
    // assembled the instant front/back settled — the still-uploading tag was
    // silently dropped and the model never saw it (edge logs showed
    // photoCount:2 [front,back] on items shot WITH tags). Exactly the two tag
    // slots qualify; widening this would make the extract wait on photos that
    // do not carry brand/size.
    func test_slotType_isTagSlot_isExactlyTheTwoTagSlots() {
        XCTAssertTrue(PhotoSlotType.tag.isTagSlot)
        XCTAssertTrue(PhotoSlotType.tag2.isTagSlot)
        for slot in PhotoSlotType.allCases where slot != .tag && slot != .tag2 {
            XCTAssertFalse(slot.isTagSlot, "\(slot) should not gate the AI extract")
        }
        // Tags stay OPTIONAL to capture — the gate is about waiting for one the
        // seller actually took, not about demanding it.
        XCTAssertFalse(PhotoSlotType.tag.isRequired)
        XCTAssertFalse(PhotoSlotType.tag2.isRequired)
    }

    // Both tag slots are sensitive, so they upload to the PRIVATE bucket and the
    // extract must send a SIGNED url for them. If these ever diverge, the tag is
    // either dropped from the AI request or leaked to a public URL.
    func test_tagSlots_arePrivateBucketAndSensitive() {
        for slot in [PhotoSlotType.tag, PhotoSlotType.tag2] {
            XCTAssertTrue(slot.isSensitive, "\(slot) must be sensitive")
            XCTAssertEqual(slot.storageBucket, PhotoStorageBucket.privateBucket)
        }
    }

    func test_slotType_extendedSlots_rawValueIsServerType() {
        // Every non-defect slot's rawValue IS its server photo_type, so
        // drafts / share-inbox manifests / offline sync round-trip without
        // translation.
        for slot in PhotoSlotType.allCases where !PhotoSlotType.defects.contains(slot) {
            XCTAssertEqual(slot.serverPhotoType, slot.rawValue)
        }
        XCTAssertEqual(PhotoSlotType.tag2.serverPhotoType, "tag_2")
        XCTAssertEqual(PhotoSlotType.onModel.serverPhotoType, "on_model")
        XCTAssertEqual(PhotoSlotType.measurementChest.serverPhotoType, "measurement_chest")
    }

    func test_slotType_serverTypes_existInFlipdeskPhotoTypeCatalog() {
        // The retag picker + display labels are driven by the server-type
        // catalog — every slot must map into it.
        for slot in PhotoSlotType.allCases {
            XCTAssertTrue(
                FlipdeskPhotoType.all.contains(slot.serverPhotoType),
                "\(slot.rawValue) maps to \(slot.serverPhotoType), missing from FlipdeskPhotoType.all"
            )
        }
        // And the catalog mirrors web FLIPDESK_PHOTO_TYPES (28 entries:
        // the original 17, the 8 universal roles from migration 00230, the
        // seller-reference `internal` type from US-1549, and the US-1571/77
        // `measurement` + `measurement_overlay` pair from migrations
        // 00346/00350).
        XCTAssertEqual(FlipdeskPhotoType.all.count, 28)
        XCTAssertEqual(FlipdeskPhotoType.label(for: "on_model"), "On model")
        XCTAssertEqual(FlipdeskPhotoType.label(for: "interior"), "Interior / Lining")
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
