import Foundation

/// One of the canonical photo positions the grading + listing flows expect.
/// The four `required` slots mirror what GradeThread asks for on the web
/// intake form; defect 1–3 are optional add-ons surfaced behind an
/// "Add detail / defect" disclosure.
public enum PhotoSlotType: String, CaseIterable, Identifiable, Hashable {
    case front
    case back
    case tag
    case detail
    case defect1
    case defect2
    case defect3

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .front:   return "Front"
        case .back:    return "Back"
        case .tag:     return "Tag"
        case .detail:  return "Detail"
        case .defect1: return "Defect 1"
        case .defect2: return "Defect 2"
        case .defect3: return "Defect 3"
        }
    }

    /// Single-line cue shown above the slot strip while the slot is active.
    public var hint: String {
        switch self {
        case .front:   return "Lay flat, full front in frame"
        case .back:    return "Same crop as the front shot"
        case .tag:     return "Care + size label, close enough to read"
        case .detail:  return "Texture, weave, or distinctive feature"
        case .defect1, .defect2, .defect3:
            return "Tight crop on the issue (snag, stain, missing button…)"
        }
    }

    /// SF Symbol shown in an empty slot's tile.
    public var systemImage: String {
        switch self {
        case .front, .back: return "tshirt"
        case .tag:          return "tag"
        case .detail:       return "circle.dotted.and.circle"
        case .defect1, .defect2, .defect3: return "exclamationmark.triangle"
        }
    }

    public var isRequired: Bool {
        switch self {
        case .front, .back, .tag, .detail: return true
        case .defect1, .defect2, .defect3: return false
        }
    }

    /// The four required positions in capture order. Iteration order of
    /// `allCases` includes the optional defects too — use this when you
    /// specifically want the "must fill before continuing" set.
    public static let required: [PhotoSlotType] = [.front, .back, .tag, .detail]

    /// Defect slots in display order (only the first N are surfaced based
    /// on ``PhotoIntakeStore.defectSlotsVisible``).
    public static let defects: [PhotoSlotType] = [.defect1, .defect2, .defect3]

    /// Maps the iOS slot vocabulary to the server-side `item_photos.photo_type`
    /// enum used by the web (FlipdeskPhotoType in src/types/database.ts).
    /// `detail` is the canonical name on both sides; `defect{1,2,3}` collapses
    /// to the single `defect` server type — slot order is preserved separately
    /// via `sort_order` on the row.
    public var serverPhotoType: String {
        switch self {
        case .front:   return "front"
        case .back:    return "back"
        case .tag:     return "tag"
        case .detail:  return "detail"
        case .defect1, .defect2, .defect3: return "defect"
        }
    }
}
