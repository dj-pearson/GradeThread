import Foundation

/// One of the canonical photo positions the grading + listing flows expect.
/// The four `required` slots mirror what GradeThread asks for on the web
/// intake form. Everything else is optional: defect 1–3 plus the extended
/// taxonomy (second tag, extra details, interior, flat lay, on-model, and
/// flat-measurement shots) that matches the web `FLIPDESK_PHOTO_TYPES`
/// vocabulary — surfaced behind the "Add more" affordance in the capture
/// strip.
///
/// Raw values for the extended cases equal the server `photo_type` strings
/// (e.g. `tag_2`, `on_model`) so they round-trip through drafts, the share
/// inbox, and offline sync without translation. Only `defect1`–`defect3`
/// collapse to a shared server type (`defect`).
public enum PhotoSlotType: String, CaseIterable, Identifiable, Hashable {
    case front
    case back
    case tag
    case detail
    case defect1
    case defect2
    case defect3
    case tag2 = "tag_2"
    case detail2 = "detail_2"
    case detail3 = "detail_3"
    case detail4 = "detail_4"
    case interior
    case flatlay
    case onModel = "on_model"
    // Universal roles (migration 00230) used by non-clothing photo profiles.
    // Raw values equal the server photo_type strings so they round-trip.
    case angle
    case sole
    case marking
    case serial
    case accessory
    case certificate
    case corner
    case surface
    case measurementChest = "measurement_chest"
    case measurementWaist = "measurement_waist"
    case measurementLength = "measurement_length"
    case measurementSleeve = "measurement_sleeve"
    case measurementInseam = "measurement_inseam"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .front:    return "Front"
        case .back:     return "Back"
        case .tag:      return "Tag"
        case .detail:   return "Detail"
        case .defect1:  return "Defect 1"
        case .defect2:  return "Defect 2"
        case .defect3:  return "Defect 3"
        case .tag2:     return "Tag 2"
        case .detail2:  return "Detail 2"
        case .detail3:  return "Detail 3"
        case .detail4:  return "Detail 4"
        case .interior: return "Interior"
        case .flatlay:  return "Flat lay"
        case .onModel:  return "On model"
        case .angle:       return "Angle / Profile"
        case .sole:        return "Sole"
        case .marking:     return "Markings"
        case .serial:      return "Serial / Model"
        case .accessory:   return "Accessories"
        case .certificate: return "Certificate"
        case .corner:      return "Corners"
        case .surface:     return "Surface"
        case .measurementChest:  return "Chest / Bust"
        case .measurementWaist:  return "Waist"
        case .measurementLength: return "Length"
        case .measurementSleeve: return "Sleeve"
        case .measurementInseam: return "Inseam"
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
        case .tag2:
            return "Second tag — brand stamp, size dot, or care label"
        case .detail2, .detail3, .detail4:
            return "Another close-up: hardware, stitching, print"
        case .interior:
            return "Inside-out: lining, seams, interior tags"
        case .flatlay:
            return "Styled flat lay for the listing gallery"
        case .onModel:
            return "Worn on a model or mannequin"
        case .angle:
            return "Angled 3/4 view showing the silhouette"
        case .sole:
            return "Outsole / tread — show wear honestly"
        case .marking:
            return "Hallmark, maker's mark, or brand stamp"
        case .serial:
            return "Serial, model, or reference number"
        case .accessory:
            return "Included extras — box, papers, dust bag, cables"
        case .certificate:
            return "Grading label / certificate of authenticity"
        case .corner:
            return "Close-up of the corners"
        case .surface:
            return "Surface & centering under raking light"
        case .measurementChest:
            return "Tape across the chest, garment flat, pit to pit"
        case .measurementWaist:
            return "Tape across the waistband, garment flat"
        case .measurementLength:
            return "Tape top to hem, garment flat"
        case .measurementSleeve:
            return "Tape shoulder seam to cuff"
        case .measurementInseam:
            return "Tape crotch seam to hem"
        }
    }

    /// SF Symbol shown in an empty slot's tile.
    public var systemImage: String {
        switch self {
        case .front, .back: return "tshirt"
        case .tag, .tag2:   return "tag"
        case .detail, .detail2, .detail3, .detail4:
            return "circle.dotted.and.circle"
        case .defect1, .defect2, .defect3: return "exclamationmark.triangle"
        case .interior: return "square.dashed.inset.filled"
        case .flatlay:  return "rectangle.3.group"
        case .onModel:  return "person.fill"
        case .angle:       return "cube"
        case .sole:        return "shoe"
        case .marking:     return "signature"
        case .serial:      return "number"
        case .accessory:   return "shippingbox"
        case .certificate: return "checkmark.seal"
        case .corner:      return "viewfinder"
        case .surface:     return "rays"
        case .measurementChest, .measurementWaist, .measurementLength,
             .measurementSleeve, .measurementInseam:
            return "ruler"
        }
    }

    public var isRequired: Bool {
        switch self {
        case .front, .back, .tag, .detail: return true
        default: return false
        }
    }

    /// The four required positions in capture order. Iteration order of
    /// `allCases` includes the optional slots too — use this when you
    /// specifically want the "must fill before continuing" set.
    public static let required: [PhotoSlotType] = [.front, .back, .tag, .detail]

    /// Defect slots in display order. Revealed one at a time — the "Add"
    /// menu offers a single Defect entry while any remain hidden.
    public static let defects: [PhotoSlotType] = [.defect1, .defect2, .defect3]

    /// Flat-measurement slots in display order (grouped in the "Add" menu).
    public static let measurements: [PhotoSlotType] = [
        .measurementChest, .measurementWaist, .measurementLength,
        .measurementSleeve, .measurementInseam,
    ]

    /// Non-defect, non-measurement optional slots in display order.
    public static let extras: [PhotoSlotType] = [
        .tag2, .detail2, .detail3, .detail4, .interior, .flatlay, .onModel,
    ]

    /// Maps the iOS slot vocabulary to the server-side `item_photos.photo_type`
    /// enum used by the web (FlipdeskPhotoType in src/types/database.ts).
    /// `defect{1,2,3}` collapses to the single `defect` server type — slot
    /// order is preserved separately via `sort_order` on the row. Every other
    /// slot's raw value IS its server type.
    public var serverPhotoType: String {
        switch self {
        case .defect1, .defect2, .defect3: return "defect"
        default: return rawValue
        }
    }

    /// Maps a server `item_photos.photo_type` string back to a capture slot.
    /// The single `defect` server type maps to the first defect slot; every
    /// other slot's raw value IS its server type. Returns nil for unknown
    /// strings so callers can skip rather than crash. Used by photo profiles
    /// to resolve their role list into capture slots.
    public init?(serverType: String) {
        if serverType == "defect" {
            self = .defect1
            return
        }
        self.init(rawValue: serverType)
    }
}

/// The server-side `item_photos.photo_type` vocabulary — a mirror of the web's
/// `FLIPDESK_PHOTO_TYPES` + `PHOTO_TYPE_LABELS` (src/lib/constants.ts). Used
/// wherever a PERSISTED photo's type string needs a human label or a retag
/// picker (`PhotoSlotType` covers capture-time slots; this covers rows that
/// already exist, which carry the server string).
public enum FlipdeskPhotoType {
    /// All server photo types in the web's canonical display order.
    public static let all: [String] = [
        "front", "back", "tag", "tag_2",
        "detail", "detail_2", "detail_3", "detail_4",
        "interior", "defect", "flatlay", "on_model",
        "angle", "sole", "marking", "serial", "accessory",
        "certificate", "corner", "surface",
        "measurement_chest", "measurement_waist", "measurement_length",
        "measurement_sleeve", "measurement_inseam",
    ]

    /// Human label for a server `photo_type` string. Unknown values fall back
    /// to a de-underscored capitalization so new server types never render as
    /// raw snake_case.
    public static func label(for serverType: String) -> String {
        switch serverType {
        case "front":    return "Front"
        case "back":     return "Back"
        case "tag":      return "Garment Tag"
        case "tag_2":    return "Garment Tag 2"
        case "detail":   return "Detail 1"
        case "detail_2": return "Detail 2"
        case "detail_3": return "Detail 3"
        case "detail_4": return "Detail 4"
        case "interior": return "Interior / Lining"
        case "defect":   return "Defect"
        case "flatlay":  return "Flat lay"
        case "on_model": return "On model"
        case "angle":       return "Angle / Profile"
        case "sole":        return "Sole"
        case "marking":     return "Markings / Hallmark"
        case "serial":      return "Serial / Model"
        case "accessory":   return "Accessories / Box"
        case "certificate": return "Certificate / Label"
        case "corner":      return "Corners"
        case "surface":     return "Surface / Centering"
        case "measurement_chest":  return "Measure: Chest / Bust"
        case "measurement_waist":  return "Measure: Waist"
        case "measurement_length": return "Measure: Length"
        case "measurement_sleeve": return "Measure: Sleeve"
        case "measurement_inseam": return "Measure: Inseam"
        default:
            return serverType
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        }
    }
}
