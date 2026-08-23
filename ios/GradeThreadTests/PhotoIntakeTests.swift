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

    // MARK: - PhotoIntakeStore (US-2470: profile-driven slots)

    /// The strip before any server table lands: the bundled clothing profile's
    /// default slots. Front and back block; the third and fourth are the first
    /// tag and the first detail ROLE, not a generic "Tag" / "Detail".
    private var fallbackDefaults: [CaptureSlot] {
        PhotoProfile.clothingFallback.defaultCaptureSlots
    }

    func test_store_startsWithFrontSlotActive_andNoPhotos() {
        let store = PhotoIntakeStore()
        XCTAssertEqual(store.activeSlot, .front)
        XCTAssertTrue(store.photos.isEmpty)
        XCTAssertFalse(store.allRequiredFilled)
        XCTAssertFalse(store.hasUnsavedShots)
    }

    /// The default strip is one slot per KIND, not the first four roles.
    ///
    /// The server profiles mark only front and back required, so "the required
    /// ones" would open on two slots; and clothing's role order is front, back,
    /// tag:brand, tag:size, so "the first four" would offer two tag shots and no
    /// detail. One of each kind reproduces the four-slot strip this has always
    /// shown, from data rather than from a hard-coded list.
    func test_store_defaultStrip_isOneSlotPerKind() {
        let store = PhotoIntakeStore()
        XCTAssertEqual(store.visibleSlots.count, 4)
        XCTAssertEqual(
            store.visibleSlots.map(\.serverPhotoType),
            ["front", "back", "tag", "detail"]
        )
        XCTAssertEqual(store.visibleSlots[2].role, "brand")
        XCTAssertEqual(store.visibleSlots[3].role, "fabric")
        // Only front + back block.
        XCTAssertEqual(store.requiredSlots.map(\.serverPhotoType), ["front", "back"])
    }

    func test_store_recordCapture_advancesToNextEmptySlot() {
        let store = PhotoIntakeStore()
        let strip = store.visibleSlots
        store.recordCapture(makeCapture())
        XCTAssertEqual(store.activeSlot, strip[1])
        store.recordCapture(makeCapture())
        XCTAssertEqual(store.activeSlot, strip[2])
        store.recordCapture(makeCapture())
        XCTAssertEqual(store.activeSlot, strip[3])
        store.recordCapture(makeCapture())

        // With every visible slot filled and no defects revealed, the next
        // empty slot is nil; activeSlot stays on the last-captured one.
        XCTAssertNil(store.nextEmptySlot)
        XCTAssertEqual(store.activeSlot, strip[3])
        XCTAssertTrue(store.allRequiredFilled)
    }

    func test_store_revealNextDefectSlot_addsOptionalCapacity() {
        let store = PhotoIntakeStore()
        let defects = PhotoProfile.clothingFallback.defectCaptureSlots
        XCTAssertEqual(defects.count, 3)
        XCTAssertEqual(store.visibleSlots, fallbackDefaults)

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, fallbackDefaults + [defects[0]])

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, fallbackDefaults + [defects[0], defects[1]])

        store.revealNextDefectSlot()
        XCTAssertEqual(store.visibleSlots, fallbackDefaults + defects)

        // Fourth reveal is a no-op — there are only three defect slots.
        store.revealNextDefectSlot()
        XCTAssertFalse(store.canAddDefectSlot)
        XCTAssertEqual(store.visibleSlots.count, fallbackDefaults.count + 3)
    }

    /// The defect entries take their wording from the PROFILE, so a category
    /// whose flaws are called something else says so.
    func test_store_defectSlots_carryProfileWording() throws {
        let store = PhotoIntakeStore()
        let defect = try XCTUnwrap(store.nextHiddenDefectSlot)
        XCTAssertEqual(defect.label, "Defect")
        XCTAssertEqual(defect.serverPhotoType, "defect")
        XCTAssertNil(defect.role)
    }

    func test_store_setActiveSlot_ignoresHiddenDefectSlots() {
        let store = PhotoIntakeStore()
        let defect1 = PhotoProfile.clothingFallback.defectCaptureSlots[0]
        store.setActiveSlot(defect1)
        // Defect slot isn't visible yet, so the request is ignored.
        XCTAssertEqual(store.activeSlot, .front)

        store.revealNextDefectSlot()
        store.setActiveSlot(defect1)
        XCTAssertEqual(store.activeSlot, defect1)
    }

    func test_store_clearPhoto_reFocusesEmptySlot() {
        let store = PhotoIntakeStore()
        let strip = store.visibleSlots
        store.recordCapture(makeCapture())       // front filled, active -> back
        store.recordCapture(makeCapture())       // back filled, active -> next
        XCTAssertEqual(store.activeSlot, strip[2])

        store.clearPhoto(at: .front)
        // Active slot already points at a still-empty slot; the cleared front
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
        let tagSlot = store.visibleSlots[2]

        store.setPhoto(photo, for: tagSlot)

        XCTAssertEqual(store.photos[tagSlot]?.id, photo.id)
        XCTAssertEqual(store.activeSlot, .front)  // cursor untouched
        XCTAssertNil(store.photos[.front])
        XCTAssertEqual(store.nextEmptySlot, .front)
    }

    func test_store_setPhoto_acrossSlots_independentOfCaptureOrder() {
        // Mirrors the library-import + camera mixed flow: assign a library photo
        // to the tag slot first, then capture front + back. The store should not
        // reshuffle anything just because they arrived in a weird order.
        let store = PhotoIntakeStore()
        let strip = store.visibleSlots
        store.setPhoto(makeCapture(), for: strip[2])
        store.recordCapture(makeCapture())   // front
        store.recordCapture(makeCapture())   // back (front filled, advances)

        XCTAssertNotNil(store.photos[strip[0]])
        XCTAssertNotNil(store.photos[strip[1]])
        XCTAssertNotNil(store.photos[strip[2]])
        XCTAssertNil(store.photos[strip[3]])
        XCTAssertEqual(store.nextEmptySlot, strip[3])
    }

    func test_store_revealThenSetPhoto_makesDefectSlotsVisible() {
        let store = PhotoIntakeStore()
        let defect1 = PhotoProfile.clothingFallback.defectCaptureSlots[0]
        XCTAssertFalse(store.visibleSlots.contains(defect1))

        store.revealNextDefectSlot()
        store.setPhoto(makeCapture(), for: defect1)

        XCTAssertTrue(store.visibleSlots.contains(defect1))
        XCTAssertNotNil(store.photos[defect1])
    }

    // MARK: - Profile-driven optional slots (US-2470)

    func test_store_reveal_addsArbitraryOptionalSlot() {
        let store = PhotoIntakeStore()
        let flatlay = CaptureSlot(.flatlay)
        XCTAssertFalse(store.visibleSlots.contains(flatlay))

        store.reveal(flatlay)
        XCTAssertEqual(store.visibleSlots, fallbackDefaults + [flatlay])

        // Re-revealing is a no-op; default slots cannot be "revealed".
        store.reveal(flatlay)
        store.reveal(.front)
        XCTAssertEqual(store.visibleSlots, fallbackDefaults + [flatlay])
    }

    func test_store_setPhoto_autoRevealsHiddenOptionalSlot() {
        let store = PhotoIntakeStore()
        let interior = CaptureSlot(.interior)
        store.setPhoto(makeCapture(), for: interior)

        XCTAssertTrue(store.visibleSlots.contains(interior))
        XCTAssertNotNil(store.photos[interior])
    }

    /// AC1: the "Add more" menu is the PROFILE's slots.
    func test_store_hiddenExtraSlots_comeFromTheProfile() {
        let store = PhotoIntakeStore()
        let defects = PhotoProfile.clothingFallback.defectCaptureSlots

        // Only the FIRST hidden defect is offered (defects reveal in order).
        XCTAssertEqual(store.hiddenExtraSlots.first, defects[0])
        XCTAssertFalse(store.hiddenExtraSlots.contains(defects[1]))

        // The size tag is offered BY NAME. It used to be called "Tag 2".
        let sizeTag = CaptureSlot(type: .tag, role: "size")
        XCTAssertTrue(store.hiddenExtraSlots.contains(sizeTag))
        XCTAssertEqual(store.hiddenExtraSlots.first { $0 == sizeTag }?.label, "Size tag")

        store.reveal(defects[0])
        store.reveal(sizeTag)
        XCTAssertEqual(store.hiddenExtraSlots.first, defects[1])
        XCTAssertFalse(store.hiddenExtraSlots.contains(sizeTag))
    }

    /// Measurements get their own menu section, so five tape shots cannot bury
    /// everything else. The split has to be exhaustive: an entry that lands in
    /// neither list is an entry the seller can never reach.
    func test_store_menuSections_partitionTheHiddenSlots() {
        let store = PhotoIntakeStore()
        let general = store.hiddenGeneralSlots
        let measurements = store.hiddenMeasurementSlots
        let defect = store.nextHiddenDefectSlot

        XCTAssertTrue(measurements.allSatisfy { $0.serverPhotoType == "measurement" })
        XCTAssertTrue(general.allSatisfy { $0.serverPhotoType != "measurement" })
        XCTAssertFalse(general.contains { $0.isDefect })

        var covered = Set(general + measurements)
        if let defect { covered.insert(defect) }
        XCTAssertEqual(covered, Set(store.hiddenExtraSlots))
    }

    /// AC4: a RETIRED type is never offered for a new capture. `tag_2`,
    /// `detail_2..4` and `measurement_*` stay legal values forever (Postgres
    /// cannot drop an enum value and historical rows point at them) but the
    /// strip must never mint another one.
    func test_store_neverOffersARetiredType() {
        let store = PhotoIntakeStore()
        for slot in store.visibleSlots + store.hiddenExtraSlots {
            XCTAssertFalse(
                FlipdeskPhotoType.isRetired(slot.serverPhotoType),
                "\(slot.storageKey) is retired and must not be offered for a new capture"
            )
        }
        // The refusal lives at the profile-to-slot boundary, so no capture
        // surface has to remember the rule.
        let retired = PhotoRole(
            type: "tag_2", role: nil, label: "Tag 2", hint: "", required: false, icon: "tag"
        )
        XCTAssertNil(retired.captureSlot)
    }

    /// AC1 + AC2: a different profile means different slots, keyed on the pair.
    func test_store_applyProfile_swapsTheStrip_andKeepsCapturedSlots() {
        let store = PhotoIntakeStore()
        let firstTag = store.visibleSlots[2]
        store.setPhoto(makeCapture(), for: firstTag)

        store.apply(profile: PhotoProfile.genericFallback)
        // The generic profile has no tag slot at all...
        XCTAssertFalse(PhotoProfile.genericFallback.captureSlots.contains(firstTag))
        // ...but the photo already shot under it is still in the strip, not lost.
        XCTAssertTrue(store.visibleSlots.contains(firstTag))
        XCTAssertNotNil(store.photos[firstTag])
    }

    /// AC3: `sort_order` is the profile's role order, and index 0 is the cover.
    func test_store_orderedCaptures_followProfileOrder() {
        let store = PhotoIntakeStore()
        let strip = store.visibleSlots
        // Capture out of order on purpose.
        store.setPhoto(makeCapture(), for: strip[3])
        store.setPhoto(makeCapture(), for: strip[0])
        store.setPhoto(makeCapture(), for: strip[2])

        let order = store.orderedCaptures.map(\.slot)
        XCTAssertEqual(order, [strip[0], strip[2], strip[3]])
        XCTAssertEqual(order.first?.serverPhotoType, "front", "index 0 is the eBay cover")

        // A defect is not in the profile's capture list, so it sorts AFTER
        // everything the profile does name, never into the cover position.
        let defect1 = PhotoProfile.clothingFallback.defectCaptureSlots[0]
        store.setPhoto(makeCapture(), for: defect1)
        XCTAssertEqual(store.orderedCaptures.last?.slot, defect1)
        XCTAssertEqual(store.orderedCaptures.first?.slot, strip[0])
    }

    // MARK: - CaptureSlot identity (US-2470)

    func test_captureSlot_identityIsThePair_notTheLabel() {
        let a = CaptureSlot(type: .tag, role: "size", label: "Size tag", hint: "x")
        let b = CaptureSlot(type: .tag, role: "size", label: "Trouser size", hint: "y")
        XCTAssertEqual(a, b, "a slot rebuilt under different wording must still match")
        XCTAssertEqual(a.storageKey, "tag|size")

        XCTAssertNotEqual(a, CaptureSlot(type: .tag, role: "brand"))
        XCTAssertNotEqual(a, CaptureSlot(.tag), "a roled tag is not the bare tag slot")

        // Empty and whitespace roles normalise to nil, so they cannot mint a
        // second slot that looks identical in the strip.
        XCTAssertEqual(CaptureSlot(type: .tag, role: ""), CaptureSlot(.tag))
        XCTAssertEqual(CaptureSlot(type: .tag, role: "  "), CaptureSlot(.tag))

        // The three defect slots share a server type and stay distinct.
        let defects = PhotoProfile.clothingFallback.defectCaptureSlots
        XCTAssertEqual(Set(defects).count, 3)
        XCTAssertEqual(Set(defects.map(\.serverPhotoType)), ["defect"])
    }

    func test_captureSlot_storageKey_roundTrips_andAcceptsLegacyKeys() {
        let slots = [
            CaptureSlot(.front),
            CaptureSlot(type: .tag, role: "size"),
            CaptureSlot(type: .measurementCard, role: "chest"),
        ]
        for slot in slots {
            XCTAssertEqual(CaptureSlot(storageKey: slot.storageKey), slot)
        }
        // Pre-US-2470 drafts and share-inbox batches hold a bare raw value.
        XCTAssertEqual(CaptureSlot(storageKey: "front"), CaptureSlot(.front))
        XCTAssertEqual(CaptureSlot(storageKey: "on_model"), CaptureSlot(.onModel))
        XCTAssertNil(CaptureSlot(storageKey: "not_a_slot"))
    }

    /// The tag gate is what the AI extract waits on, and under a profile every
    /// tag shot carries a role, so it has to key on the TYPE rather than on the
    /// bare `.tag` slot.
    func test_captureSlot_isTagSlot_holdsForRoledTags() {
        XCTAssertTrue(CaptureSlot(type: .tag, role: "size").isTagSlot)
        XCTAssertTrue(CaptureSlot(.tag).isTagSlot)
        XCTAssertFalse(CaptureSlot(type: .detail, role: "fabric").isTagSlot)
        // A roled tag is still sensitive, so it still uploads to the private
        // bucket. That routing keys on the type, and the role must not move it.
        XCTAssertTrue(CaptureSlot(type: .tag, role: "size").isSensitive)
        XCTAssertEqual(
            CaptureSlot(type: .tag, role: "size").storageBucket,
            PhotoStorageBucket.privateBucket
        )
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
        // And the catalog mirrors web FLIPDESK_PHOTO_TYPES (30 entries:
        // the original 17, the 8 universal roles from migration 00230, the
        // seller-reference `internal` type from US-1549, the US-1571/77
        // `measurement` + `measurement_overlay` pair from migrations
        // 00346/00350, and the US-2462 `on_hanger` + `set_pair` pair from
        // migration 00587).
        //
        // This count is expected to stay PUT from here. Since US-2462 a new tag
        // idea is a ROLE, which is data on the profile table, not an enum value
        // — so this number growing again is a signal that something was added
        // at the wrong layer.
        XCTAssertEqual(FlipdeskPhotoType.all.count, 30)
        XCTAssertEqual(FlipdeskPhotoType.label(for: "on_model"), "On model")
        XCTAssertEqual(FlipdeskPhotoType.label(for: "interior"), "Interior / Lining")
        XCTAssertEqual(FlipdeskPhotoType.label(for: "on_hanger"), "On hanger")
        XCTAssertEqual(FlipdeskPhotoType.label(for: "set_pair"), "Set / pair")
    }

    // MARK: - US-2468: the role qualifier

    func test_retiredTypes_areNotOfferedButStayLabelled() {
        // Retired types remain legal values forever (Postgres cannot drop an
        // enum value, and historical rows point at them). What changes is that
        // the picker never offers them as a NEW choice.
        for type in ["tag_2", "detail_2", "detail_3", "detail_4",
                     "measurement_chest", "measurement_inseam"] {
            XCTAssertTrue(FlipdeskPhotoType.isRetired(type), "\(type) should be retired")
            XCTAssertFalse(
                FlipdeskPhotoType.label(for: type).isEmpty,
                "\(type) must still render a label for un-backfilled rows"
            )
        }
        for type in ["front", "back", "tag", "detail", "measurement", "defect"] {
            XCTAssertFalse(FlipdeskPhotoType.isRetired(type), "\(type) is still a valid choice")
        }
    }

    func test_measurementListability_dependsOnTheRole() {
        // The trap migration 00587 walked into: `measurement` is non-listable
        // because it means the MeasureCard frame, but `measurement_chest` was a
        // listable tape shot — and the backfill folds the second into the first.
        XCTAssertTrue(FlipdeskPhotoType.isNonListable("measurement", role: nil))
        XCTAssertTrue(FlipdeskPhotoType.isNonListable("measurement"))
        XCTAssertFalse(FlipdeskPhotoType.isNonListable("measurement", role: "chest"))
        XCTAssertFalse(FlipdeskPhotoType.isNonListable("measurement", role: "inseam"))
        // Every other type ignores the role entirely.
        XCTAssertTrue(FlipdeskPhotoType.isNonListable("internal", role: "fabric"))
        XCTAssertFalse(FlipdeskPhotoType.isNonListable("detail", role: "fabric"))
        XCTAssertFalse(FlipdeskPhotoType.isNonListable("front", role: nil))
    }

    func test_roleLabel_prefersTheRoleOverTheBareType() {
        // A detail with role 'fabric' is a "Fabric close-up", not "Detail 1".
        XCTAssertEqual(FlipdeskPhotoType.label(for: "detail", role: "fabric"), "Fabric close-up")
        XCTAssertEqual(FlipdeskPhotoType.label(for: "tag", role: "size"), "Size tag")
        XCTAssertEqual(FlipdeskPhotoType.label(for: "tag", role: "made_in"), "Made in / union label")
        XCTAssertEqual(FlipdeskPhotoType.label(for: "measurement", role: "inseam"), "Measure: Inseam")
        // No role → the bare type label, unchanged.
        XCTAssertEqual(FlipdeskPhotoType.label(for: "detail", role: nil), "Detail 1")
        // A role the app has never seen still renders as words, not snake_case.
        XCTAssertFalse(FlipdeskPhotoType.label(for: "measurement", role: "leg_opening").contains("_"))
    }

    func test_slotKey_identifiesTheTypeAndRolePair() {
        // A suit profile has three `tag` slots; the key is what keeps them apart.
        XCTAssertEqual(PhotoProfile.slotKey("tag", "size"), "tag:size")
        XCTAssertEqual(PhotoProfile.slotKey("front", nil), "front")
        XCTAssertEqual(PhotoProfile.slotKey("front", ""), "front")
        XCTAssertNotEqual(PhotoProfile.slotKey("tag", "brand"), PhotoProfile.slotKey("tag", "size"))
    }

    // MARK: - Auto-assign (US-2818)

    /// The web bulk-add rule: required slots first, in profile order, so the
    /// required set completes and the item still earns "photographed".
    func test_autoAssignTargets_fillsRequiredSlotsFirst() {
        let store = PhotoIntakeStore()
        let targets = store.autoAssignTargets(count: 2)
        XCTAssertEqual(targets.map(\.serverPhotoType), ["front", "back"])
    }

    /// Past the required set the batch lands on ordinary listing slots, in the
    /// profile's own order, and never on a slot that is already taken.
    func test_autoAssignTargets_skipsFilledSlots_andContinuesDownTheStrip() {
        let store = PhotoIntakeStore()
        store.setPhoto(makeCapture(), for: store.visibleSlots[0])  // front taken

        let targets = store.autoAssignTargets(count: 4)
        XCTAssertEqual(targets.first?.serverPhotoType, "back")
        XCTAssertFalse(targets.contains(store.visibleSlots[0]))
        XCTAssertEqual(Set(targets).count, targets.count, "no slot offered twice")
    }

    /// A wrong tag on either of these is worse than no photo: a defect slot
    /// tells a buyer the garment is damaged, and the MeasureCard frame is a
    /// calibration shot the measurement pipeline reads rather than a listing
    /// photo. Both stay reachable from the per-photo menu.
    func test_autoAssignTargets_neverPicksDefectOrMeasurementSlots() {
        let store = PhotoIntakeStore()
        store.revealNextDefectSlot()

        let targets = store.autoAssignTargets(count: 40)
        XCTAssertFalse(targets.contains { $0.isDefect })
        XCTAssertFalse(targets.contains { $0.serverPhotoType == "measurement" })
    }

    func test_autoAssignTargets_isBoundedByTheBatchSize() {
        let store = PhotoIntakeStore()
        XCTAssertEqual(store.autoAssignTargets(count: 1).count, 1)
        XCTAssertTrue(store.autoAssignTargets(count: 0).isEmpty)
    }

    /// Capacity is finite, and the tray reports the real number so the tail is
    /// left in the tray to be tagged or discarded rather than dropped.
    func test_autoAssignTargets_capsAtTheAvailableSlots() {
        let store = PhotoIntakeStore()
        let unbounded = store.autoAssignTargets(count: 999)
        XCTAssertLessThan(unbounded.count, 999)
        XCTAssertGreaterThanOrEqual(unbounded.count, store.requiredSlots.count)
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
