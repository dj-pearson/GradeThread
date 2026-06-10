import Foundation
import Observation

/// Owns the per-session capture state for the photo intake flow.
/// Survives the camera lifecycle (start/stop) but is destroyed when the
/// user leaves the intake view.
@MainActor
@Observable
public final class PhotoIntakeStore {
    /// Captured photos keyed by slot. A missing key = empty slot.
    public private(set) var photos: [PhotoSlotType: PhotoCapture] = [:]

    /// Slot the next capture will land in. Capture-flow swipes / taps
    /// update this; the auto-advance after each capture also writes here.
    public var activeSlot: PhotoSlotType = .front

    /// Optional slots the user has revealed, in reveal order. Defects reveal
    /// one at a time via ``revealNextDefectSlot()``; every other optional
    /// type (tag 2, extra details, interior, flat lay, on-model,
    /// measurements) reveals directly via ``reveal(_:)`` from the "Add"
    /// menu on the intake view.
    public private(set) var extraSlots: [PhotoSlotType] = []

    public init() {}

    // MARK: - Derived state

    /// Slots currently displayed in the strip: 4 required + revealed extras.
    public var visibleSlots: [PhotoSlotType] {
        PhotoSlotType.required + extraSlots
    }

    /// How many defect slots are currently revealed (0…3).
    public var defectSlotsVisible: Int {
        extraSlots.filter { PhotoSlotType.defects.contains($0) }.count
    }

    /// First slot without a capture, scanning the visible strip in order.
    /// Used to auto-advance after a capture lands.
    public var nextEmptySlot: PhotoSlotType? {
        visibleSlots.first { photos[$0] == nil }
    }

    public var allRequiredFilled: Bool {
        PhotoSlotType.required.allSatisfy { photos[$0] != nil }
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

    /// The first defect slot not yet revealed, if any.
    public var nextHiddenDefectSlot: PhotoSlotType? {
        PhotoSlotType.defects.first { !extraSlots.contains($0) }
    }

    /// Optional slots offerable from the "Add" menu: the next hidden defect
    /// (defects reveal one at a time), then every extended-taxonomy slot not
    /// yet revealed, in canonical display order.
    public var hiddenExtraSlots: [PhotoSlotType] {
        var out: [PhotoSlotType] = []
        if let nextDefect = nextHiddenDefectSlot { out.append(nextDefect) }
        out += (PhotoSlotType.extras + PhotoSlotType.measurements)
            .filter { !extraSlots.contains($0) }
        return out
    }

    // MARK: - Mutations

    /// Stores a photo in the currently-active slot and advances to the
    /// next empty slot (or stays put if everything's filled).
    public func recordCapture(_ photo: PhotoCapture) {
        photos[activeSlot] = photo
        if let next = nextEmptySlot {
            activeSlot = next
        }
    }

    /// Stores a photo in a specific slot. Used by the library-import flow
    /// (US-174) which lets the user assign each picked image after picking,
    /// and by draft restore. Optional slots auto-reveal so the assigned photo
    /// is always visible in the strip.
    public func setPhoto(_ photo: PhotoCapture, for slot: PhotoSlotType) {
        reveal(slot)
        photos[slot] = photo
    }

    public func clearPhoto(at slot: PhotoSlotType) {
        photos.removeValue(forKey: slot)
        // If the cleared slot becomes the natural next-up, focus it so the
        // user can retake without a manual tap.
        if let next = nextEmptySlot, photos[activeSlot] != nil {
            activeSlot = next
        }
    }

    public func setActiveSlot(_ slot: PhotoSlotType) {
        // Don't allow focusing an optional slot that hasn't been revealed
        // yet — the slot strip wouldn't be rendering it.
        guard visibleSlots.contains(slot) else { return }
        activeSlot = slot
    }

    /// Reveals an optional slot so it appears in the strip. No-op for
    /// required slots (always visible) and already-revealed ones.
    public func reveal(_ slot: PhotoSlotType) {
        guard !slot.isRequired, !extraSlots.contains(slot) else { return }
        extraSlots.append(slot)
    }

    /// Reveals one more defect slot, up to the max of 3.
    public func revealNextDefectSlot() {
        guard let next = nextHiddenDefectSlot else { return }
        reveal(next)
    }

    /// Resets state for a fresh intake session.
    public func reset() {
        photos.removeAll()
        activeSlot = .front
        extraSlots.removeAll()
    }
}
