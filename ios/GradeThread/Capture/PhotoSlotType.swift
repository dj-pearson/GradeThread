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
/// Declaration order IS the canonical gallery/cover order — `PhotoUploadService`
/// derives each photo's `sort_order` from `allCases.firstIndex(of:)`, so index 0
/// (`front`) is the cover / eBay main image. Canonical sequence:
/// Front → Back → Tag → Detail → measurements → defects → extras → universal.
public enum PhotoSlotType: String, CaseIterable, Identifiable, Hashable, Sendable {
    case front
    case back
    case tag
    case detail
    case measurementChest = "measurement_chest"
    case measurementWaist = "measurement_waist"
    case measurementLength = "measurement_length"
    case measurementSleeve = "measurement_sleeve"
    case measurementInseam = "measurement_inseam"
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
    // US-1575 (migration 00346): the MeasureCard flat-lay frame. Skippable,
    // never listed; the photo-measurement pipeline keys on this tag.
    case measurementCard = "measurement"
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
    // US-2470 (migration 00587): the two profile roles that had no existing
    // capture case, so a profile offering them silently dropped the slot.
    // Declared LAST because this enum's declaration order used to BE the
    // sort_order contract; the profile's role order owns that now, and
    // appending leaves every pre-profile ordering exactly where it was.
    case onHanger = "on_hanger"
    case setPair = "set_pair"

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
        case .measurementCard: return "Measurement card"
        case .angle:       return "Angle / Profile"
        case .sole:        return "Sole"
        case .marking:     return "Markings"
        case .serial:      return "Serial / Model"
        case .accessory:   return "Accessories"
        case .certificate: return "Certificate"
        case .corner:      return "Corners"
        case .onHanger:    return "On hanger"
        case .setPair:     return "Set / pair"
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
        case .measurementCard:
            return "Garment flat, MeasureCard BESIDE it - all 4 squares visible, top-down"
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
        case .onHanger:
            return "Hung as it would be worn — shows how it drapes"
        case .setPair:
            return "Both pieces together, so the set reads as one item"
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
        case .onHanger:    return "hanger"
        case .setPair:     return "square.on.square"
        case .surface:     return "rays"
        case .measurementChest, .measurementWaist, .measurementLength,
             .measurementSleeve, .measurementInseam, .measurementCard:
            return "ruler"
        }
    }

    /// True for the blocking slots only (Front + Back). Tag + Detail are
    /// default capture slots (``defaultSlots``) but are NOT required — see
    /// ``defaultSlots`` for why.
    public var isRequired: Bool {
        switch self {
        case .front, .back: return true
        default: return false
        }
    }

    /// A garment TAG close-up — where brand, size and fabric content are
    /// actually printed. Optional to capture, but when the seller does capture
    /// one it is the single most valuable photo the AI extract can be given, so
    /// the extract waits for it to finish uploading rather than racing ahead
    /// with front/back alone (see `AIExtractionManager.waitForRequiredUploads`).
    public var isTagSlot: Bool {
        switch self {
        case .tag, .tag2: return true
        default: return false
        }
    }

    /// The default capture slots, always visible in the strip and never
    /// revealed/removed. Front + Back are required; Tag + Detail are shown so
    /// sellers naturally add them, but are skippable — many garments (e.g.
    /// Lululemon with a cut size label) have no readable tag, and a missing
    /// detail shouldn't block listing. Use this for what the strip DISPLAYS.
    public static let defaultSlots: [PhotoSlotType] = [.front, .back, .tag, .detail]

    /// The blocking set — must be filled before leaving capture and before
    /// grading (mirrors the server `has_required_photos` / grading gate). Use
    /// this for "must fill", NOT for what the strip displays (``defaultSlots``).
    public static let required: [PhotoSlotType] = [.front, .back]

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
    /// All server photo types in the web's canonical display order
    /// (mirrors src/lib/constants.ts FLIPDESK_PHOTO_TYPES):
    /// Front → Back → Tag → Detail → measurements → defect → extras → universal.
    public static let all: [String] = [
        "front", "back", "tag", "detail",
        // US-1571 (migration 00346): MeasureCard calibration frame - the
        // whole garment flat with the fiducial card beside it. Keys the
        // photo-measurement pipeline; the edge excludes it from eBay,
        // generation AI, and public surfaces (like "internal").
        "measurement",
        // US-1577 (migration 00350): generated card-free annotated
        // measurements photo. Listing-eligible, never primary.
        "measurement_overlay",
        "measurement_chest", "measurement_waist", "measurement_length",
        "measurement_sleeve", "measurement_inseam",
        "defect",
        "tag_2", "detail_2", "detail_3", "detail_4",
        "interior", "flatlay",
        // US-2468 (migration 00587): the two types the role epic added that had
        // no existing type to reuse.
        "on_hanger", "on_model", "set_pair",
        "angle", "sole", "marking", "serial", "accessory",
        "certificate", "corner", "surface",
        // US-1549: seller-reference only (price tag paid, receipt). Stays with
        // the item in-app; the edge excludes it from eBay, AI, and public
        // surfaces. Last on purpose.
        "internal",
    ]

    /// Photo types that must never ride a listing — the client mirror of the
    /// edge's NON_LISTABLE_PHOTO_TYPES (lib/item-photo-storage.ts). The edge
    /// enforces at publish; this keeps iOS listing surfaces honest too.
    public static let nonListable: Set<String> = ["internal", "measurement"]

    /// US-2468: retired types. Still legal values forever — Postgres cannot
    /// drop an enum value and historical rows point at them — but never offered
    /// as a NEW choice. Migration 00587 rewrote existing rows onto the (type,
    /// role) pairs below; the map stays so a row that has not been rewritten
    /// yet can still be labelled.
    public static let retired: [String: (type: String, role: String?)] = [
        "tag_2": ("tag", nil),
        "detail_2": ("detail", nil),
        "detail_3": ("detail", nil),
        "detail_4": ("detail", nil),
        "measurement_chest": ("measurement", "chest"),
        "measurement_waist": ("measurement", "waist"),
        "measurement_length": ("measurement", "length"),
        "measurement_sleeve": ("measurement", "sleeve"),
        "measurement_inseam": ("measurement", "inseam"),
    ]

    public static func isRetired(_ serverType: String) -> Bool {
        retired[serverType] != nil
    }

    /// True when a server `photo_type` never publishes to a marketplace.
    ///
    /// US-2468: role-aware, mirroring the edge's `isNonListableItemPhoto`.
    /// `measurement` now covers two different photos and only one is unlistable:
    /// a NULL role is the MeasureCard calibration frame (a branded foreign
    /// object, never lists), while any role is a tape close-up — what
    /// `measurement_chest` used to be, and something sellers publish on purpose.
    /// Pre-00587 rows have a nil role, so the old behavior is preserved exactly.
    public static func isNonListable(_ serverType: String, role: String? = nil) -> Bool {
        if serverType == "measurement" { return role == nil || role?.isEmpty == true }
        return nonListable.contains(serverType)
    }

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
        case "measurement":        return "Measurement card (not listed)"
        case "measurement_overlay": return "Measurements photo (generated)"
        case "measurement_chest":  return "Measure: Chest / Bust"
        case "measurement_waist":  return "Measure: Waist"
        case "measurement_length": return "Measure: Length"
        case "measurement_sleeve": return "Measure: Sleeve"
        case "measurement_inseam": return "Measure: Inseam"
        case "internal": return "Internal (not listed)"
        case "on_hanger": return "On hanger"
        case "set_pair":  return "Set / pair"
        default:
            return serverType
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        }
    }

    /// US-2468: the label for a stored (type, role) PAIR.
    ///
    /// The role is what carries the meaning now, so a bare type label is the
    /// FALLBACK rather than the answer: a `detail` with role 'fabric' is a
    /// "Fabric close-up", not "Detail 1". `profile` supplies the
    /// category-specific wording when one is loaded — the same reason the web
    /// picker prefers the profile's label ("Sweatband" on a hat, not
    /// "Interior / Lining").
    public static func label(
        for serverType: String,
        role: String?,
        profile: PhotoProfile? = nil
    ) -> String {
        if let match = profile?.role(forServerType: serverType, photoRole: role),
           match.role == role {
            return match.label
        }
        if let role, !role.isEmpty {
            return PhotoRoleVocabulary.label(type: serverType, role: role)
                ?? label(for: serverType)
        }
        return label(for: serverType)
    }
}

/// US-2468: the role half of the tag vocabulary — the iOS mirror of
/// src/lib/photo-roles.ts.
///
/// Only the LABELS live here. The authoritative per-garment role LISTS come
/// from the profile table the edge serves, so a new role ships without an App
/// Store release; this table exists so a role that arrives before the app knows
/// about it still renders as words rather than as `made_in`.
public enum PhotoRoleVocabulary {
    public static let tagRoles: [(key: String, label: String)] = [
        ("brand", "Brand label"),
        ("size", "Size tag"),
        ("care", "Care & fabric"),
        ("made_in", "Made in / union label"),
        ("size_alt", "Trouser size tag"),
    ]

    public static let detailRoles: [(key: String, label: String)] = [
        ("fabric", "Fabric close-up"),
        ("hem", "Hem & stitching"),
        ("hardware", "Hardware"),
        ("pocket", "Pocket"),
        ("print", "Print or graphic"),
        ("collar", "Collar or cuff"),
        ("handles", "Handles & straps"),
        ("base", "Base"),
        ("ends_edges", "Ends & edges"),
        ("insole", "Insole"),
    ]

    /// Measurement roles are DERIVED from the measurement templates on the
    /// server, so their keys are measurement field keys. Labelled from the
    /// shared catalog rather than a second hand-maintained list.
    public static func label(type: String, role: String) -> String? {
        switch type {
        case "tag":
            return tagRoles.first { $0.key == role }?.label
        case "detail":
            return detailRoles.first { $0.key == role }?.label
        case "measurement":
            // MeasurementCatalog already de-underscores unknown keys, so a role
            // the app has never seen still reads as words.
            return "Measure: \(MeasurementCatalog.label(for: role))"
        default:
            return nil
        }
    }

    // US-2461: which of the roles above belong to which garment group. The lists
    // above are the flat union of every group — the right shape for LABELLING an
    // arbitrary stored role, the wrong shape for OFFERING one, since "Handles &
    // straps" in a t-shirt's menu is exactly the noise the epic set out to
    // remove. Mirrors DETAIL_ROLES_BY_GROUP / TAG_ROLES_BY_GROUP in
    // src/lib/photo-roles.ts and the Kotlin `PhotoRoleVocabulary`.
    private static let baseTagRoleKeys = ["brand", "size", "care", "made_in"]
    private static let baseDetailRoleKeys =
        ["fabric", "hem", "hardware", "pocket", "print", "collar"]
    private static let detailRoleKeysByGroup: [GarmentGroup: [String]] = [
        .bag: ["handles", "base"],
        .accessory: ["ends_edges"],
        .shoes: ["insole"],
    ]
    private static let tagRoleKeysByGroup: [GarmentGroup: [String]] = [
        // Only a suit needs a second size label: it is the only garment that is
        // genuinely two garments, and a buyer needs both numbers.
        .suit: ["size_alt"],
    ]

    /// US-2461: every role a seller may PICK for `type` on a `group` garment, in
    /// offer order.
    ///
    /// `measurement` deliberately returns nothing. Its roles are the group's
    /// measurement-template fields, which only the server knows — they arrive on
    /// the photo profile, so the profile is the one authority for them and a
    /// third copy of the template table would only create a way to disagree.
    public static func roles(
        for type: String,
        group: GarmentGroup
    ) -> [(key: String, label: String)] {
        switch type {
        case "tag":
            return (baseTagRoleKeys + (tagRoleKeysByGroup[group] ?? []))
                .compactMap { key in tagRoles.first { $0.key == key } }
        case "detail":
            return (baseDetailRoleKeys + (detailRoleKeysByGroup[group] ?? []))
                .compactMap { key in detailRoles.first { $0.key == key } }
        default:
            return []
        }
    }

    /// True when `type` carries a qualifier at all — mirrors `typeTakesRole`.
    public static func takesRole(_ type: String) -> Bool {
        type == "tag" || type == "detail" || type == "measurement"
    }
}
