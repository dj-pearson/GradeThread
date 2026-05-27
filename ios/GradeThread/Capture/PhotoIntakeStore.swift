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

    /// How many defect slots are currently revealed (0…3). Bound to the
    /// "Add detail / defect" button on the intake view.
    public private(set) var defectSlotsVisible: Int = 0

    public init() {}

    // MARK: - Derived state

    /// Slots currently displayed in the strip: 4 required + first N defects.
    public var visibleSlots: [PhotoSlotType] {
        PhotoSlotType.required + PhotoSlotType.defects.prefix(defectSlotsVisible)
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
        defectSlotsVisible < PhotoSlotType.defects.count
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
    /// (US-174) which lets the user assign each picked image after picking.
    public func setPhoto(_ photo: PhotoCapture, for slot: PhotoSlotType) {
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
        // Don't allow focusing a defect slot that hasn't been revealed yet
        // — the slot strip wouldn't be rendering it.
        guard visibleSlots.contains(slot) else { return }
        activeSlot = slot
    }

    /// Reveals one more defect slot, up to the max of 3.
    public func revealNextDefectSlot() {
        guard canAddDefectSlot else { return }
        defectSlotsVisible += 1
    }

    /// Resets state for a fresh intake session.
    public func reset() {
        photos.removeAll()
        activeSlot = .front
        defectSlotsVisible = 0
    }
}
