import Foundation
import Observation

/// Owns the per-session capture state for the photo intake flow.
/// Survives the camera lifecycle (start/stop) but is destroyed when the
/// user leaves the intake view.
///
/// US-2470: slots are ``CaptureSlot`` — a (photo_type, photo_role) pair — and
/// which ones exist comes from the resolved ``PhotoProfile``, not from a fixed
/// list of enum cases. A suit profile can therefore hold three separate tag
/// slots, and a bottom is never offered a sleeve measurement.
@MainActor
@Observable
public final class PhotoIntakeStore {
    /// Captured photos keyed by slot. A missing key = empty slot.
    public private(set) var photos: [CaptureSlot: PhotoCapture] = [:]

    /// Slot the next capture will land in. Capture-flow swipes / taps
    /// update this; the auto-advance after each capture also writes here.
    public var activeSlot: CaptureSlot = CaptureSlot(.front)

    /// The resolved photo profile for this item's category. Drives which slots
    /// the strip shows, what they are called, and their `sort_order`.
    ///
    /// Starts on the bundled clothing fallback so the strip is never empty
    /// while ``PhotoProfileStore`` fetches the server table.
    public private(set) var profile: PhotoProfile = .clothingFallback

    /// Slots always shown in the strip, in profile order.
    public private(set) var baseSlots: [CaptureSlot] = PhotoProfile.clothingFallback.defaultCaptureSlots

    /// Optional slots the user has revealed, in reveal order. Defects reveal
    /// one at a time via ``revealNextDefectSlot()``; every other optional slot
    /// reveals directly via ``reveal(_:)`` from the "Add more" menu.
    public private(set) var extraSlots: [CaptureSlot] = []

    public init() {}

    // MARK: - Profile

    /// Swaps in a resolved profile.
    ///
    /// Anything already CAPTURED under a slot the new profile does not show by
    /// default is moved into ``extraSlots`` rather than dropped. The server
    /// table lands mid-session (the fetch races the camera opening), and a
    /// seller who had already shot a tag would otherwise watch it vanish from
    /// the strip while its bytes sat in `photos` waiting to upload.
    public func apply(profile newProfile: PhotoProfile) {
        guard newProfile != profile else { return }
        // Snapshot the OLD strip order before anything moves. `photos.keys` is
        // unordered, so carrying slots over from the dictionary alone would
        // shuffle the strip differently on each launch.
        let oldOrder = visibleSlots
        profile = newProfile
        let newBase = newProfile.defaultCaptureSlots
        baseSlots = newBase

        var carried: [CaptureSlot] = []
        for slot in oldOrder where !newBase.contains(slot) && !carried.contains(slot) {
            if extraSlots.contains(slot) || photos[slot] != nil { carried.append(slot) }
        }
        for slot in photos.keys where !newBase.contains(slot) && !carried.contains(slot) {
            carried.append(slot)
        }
        extraSlots = carried

        if !visibleSlots.contains(activeSlot) {
            activeSlot = nextEmptySlot ?? visibleSlots.first ?? CaptureSlot(.front)
        }
    }

    // MARK: - Derived state

    /// Slots currently displayed in the strip: the profile's default slots plus
    /// whatever the seller has revealed.
    public var visibleSlots: [CaptureSlot] {
        baseSlots + extraSlots
    }

    /// How many defect slots are currently revealed (0…3).
    public var defectSlotsVisible: Int {
        extraSlots.filter { $0.isDefect }.count
    }

    /// First slot without a capture, scanning the visible strip in order.
    /// Used to auto-advance after a capture lands.
    public var nextEmptySlot: CaptureSlot? {
        visibleSlots.first { photos[$0] == nil }
    }

    /// The blocking slots for this profile — front + back in every profile
    /// shipped so far, but read from the profile rather than assumed.
    public var requiredSlots: [CaptureSlot] {
        let blocking = profile.captureSlots.filter { $0.isBlocking }
        return blocking.isEmpty ? CaptureSlot.blocking : blocking
    }

    public var allRequiredFilled: Bool {
        requiredSlots.allSatisfy { photos[$0] != nil }
    }

    /// True iff the user has any captured photos. Drives the exit-
    /// confirmation prompt — if they haven't snapped anything, the X
    /// dismisses without warning.
    public var hasUnsavedShots: Bool {
        !photos.isEmpty
    }

    public var canAddDefectSlot: Bool {
        nextHiddenDefectSlot != nil
    }

    /// The first defect slot not yet revealed, if any. Empty when the profile
    /// does not offer defect close-ups at all.
    public var nextHiddenDefectSlot: CaptureSlot? {
        profile.defectCaptureSlots.first { !extraSlots.contains($0) }
    }

    /// Optional slots offerable from the "Add more" menu: the next hidden
    /// defect (defects reveal one at a time), then every profile slot not yet
    /// shown, in profile order.
    ///
    /// US-2470: this is the whole point of the story. It used to be
    /// `PhotoSlotType.extras + .measurements` — a fixed list that offered a
    /// pair of trousers an inseam AND a sleeve, and that could only name an
    /// extra tag shot "Tag 2".
    public var hiddenExtraSlots: [CaptureSlot] {
        var out: [CaptureSlot] = []
        if let nextDefect = nextHiddenDefectSlot { out.append(nextDefect) }
        let shown = Set(visibleSlots)
        out += profile.optionalCaptureSlots.filter { !shown.contains($0) }
        return out
    }

    /// The "Add more" entries grouped for the menu: measurements are a section
    /// of their own because a garment can have five of them and they would
    /// otherwise bury everything else.
    public var hiddenMeasurementSlots: [CaptureSlot] {
        hiddenExtraSlots.filter { $0.serverPhotoType == "measurement" }
    }

    /// "Add more" entries that are not measurements and not the defect entry.
    public var hiddenGeneralSlots: [CaptureSlot] {
        hiddenExtraSlots.filter { $0.serverPhotoType != "measurement" && !$0.isDefect }
    }

    // MARK: - Auto-assign (US-2818)

    /// Slots an UNLABELLED batch of photos should land in, in order, so the
    /// seller never has to tag a photo before the item exists.
    ///
    /// This is the web `bulkUpload` rule (photo-uploader.tsx): the first photos
    /// fill whatever REQUIRED slots are still empty — in profile order, so the
    /// required set completes and the item still earns "photographed" — and the
    /// rest land on ordinary listing slots the seller corrects afterwards.
    ///
    /// Two kinds of slot are deliberately never auto-filled, because a wrong tag
    /// on either is worse than no photo at all: DEFECT slots, which tell a buyer
    /// the garment is damaged, and MEASUREMENT slots, whose MeasureCard frame is
    /// a calibration shot the pipeline reads rather than a photo anyone lists.
    /// Both stay available from the tray's per-photo menu.
    public func autoAssignTargets(count: Int) -> [CaptureSlot] {
        guard count > 0 else { return [] }
        func isSafeFiller(_ slot: CaptureSlot) -> Bool {
            !slot.isDefect && slot.serverPhotoType != "measurement"
        }
        var targets: [CaptureSlot] = []
        var taken = Set<CaptureSlot>()
        func offer(_ slot: CaptureSlot) {
            guard targets.count < count, !taken.contains(slot) else { return }
            taken.insert(slot)
            targets.append(slot)
        }
        for slot in requiredSlots where photos[slot] == nil { offer(slot) }
        for slot in visibleSlots where photos[slot] == nil && isSafeFiller(slot) {
            offer(slot)
        }
        for slot in hiddenGeneralSlots { offer(slot) }
        return targets
    }

    // MARK: - Mutations

    /// Stores a photo in the currently-active slot and advances to the
    /// next empty slot (or stays put if everything's filled).
    public func recordCapture(_ photo: PhotoCapture) {
        recordCapture(photo, into: activeSlot)
    }

    /// US-1648: record a capture into an EXPLICIT slot pinned by the caller
    /// BEFORE the async capture, so a slot-strip tap mid-capture/compress can't
    /// redirect the photo into a different slot — e.g. a sensitive tag close-up
    /// landing in the public 'front' slot (and thus the public item-photos
    /// bucket). Advances the focus only when it's still on the captured slot.
    public func recordCapture(_ photo: PhotoCapture, into slot: CaptureSlot) {
        reveal(slot)
        photos[slot] = photo
        if activeSlot == slot, let next = nextEmptySlot {
            activeSlot = next
        }
    }

    /// Stores a photo in a specific slot. Used by the library-import flow
    /// (US-174) which lets the user assign each picked image after picking,
    /// and by draft restore. Optional slots auto-reveal so the assigned photo
    /// is always visible in the strip.
    public func setPhoto(_ photo: PhotoCapture, for slot: CaptureSlot) {
        reveal(slot)
        photos[slot] = photo
    }

    public func clearPhoto(at slot: CaptureSlot) {
        photos.removeValue(forKey: slot)
        // If the cleared slot becomes the natural next-up, focus it so the
        // user can retake without a manual tap.
        if let next = nextEmptySlot, photos[activeSlot] != nil {
            activeSlot = next
        }
    }

    public func setActiveSlot(_ slot: CaptureSlot) {
        // Don't allow focusing an optional slot that hasn't been revealed
        // yet — the slot strip wouldn't be rendering it.
        guard visibleSlots.contains(slot) else { return }
        activeSlot = slot
    }

    /// Reveals an optional slot so it appears in the strip. No-op for the
    /// profile's default slots (always visible) and for already-revealed ones.
    public func reveal(_ slot: CaptureSlot) {
        guard !baseSlots.contains(slot), !extraSlots.contains(slot) else { return }
        extraSlots.append(slot)
    }

    /// Reveals one more defect slot, up to the max of 3.
    public func revealNextDefectSlot() {
        guard let next = nextHiddenDefectSlot else { return }
        reveal(next)
    }

    /// Resets state for a fresh intake session. Keeps the resolved profile —
    /// the category has not changed just because the seller started over.
    public func reset() {
        photos.removeAll()
        extraSlots.removeAll()
        activeSlot = baseSlots.first ?? CaptureSlot(.front)
    }

    // MARK: - Ordering

    /// The captured photos in upload order: profile order first, then anything
    /// the profile does not list (defects, and slots carried over from an
    /// earlier profile) in the order the seller revealed them.
    ///
    /// This IS the `sort_order` contract (US-2470 AC3). It replaces
    /// `PhotoSlotType.allCases.firstIndex(of:)`, which could only express one
    /// global ordering and had no way to put a watch's dial before its
    /// caseback.
    public var orderedCaptures: [(slot: CaptureSlot, capture: PhotoCapture)] {
        let strip = visibleSlots
        func rank(_ slot: CaptureSlot) -> (Int, Int) {
            if let index = profile.sortIndex(of: slot) { return (0, index) }
            return (1, strip.firstIndex(of: slot) ?? Int.max)
        }
        return photos
            .map { (slot: $0.key, capture: $0.value) }
            .sorted {
                let a = rank($0.slot), b = rank($1.slot)
                return a.0 == b.0 ? a.1 < b.1 : a.0 < b.0
            }
    }
}
