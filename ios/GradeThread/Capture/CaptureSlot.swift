import Foundation

/// One position in the capture strip, identified by the (type, role) PAIR
/// (US-2470).
///
/// WHY THIS EXISTS AND ``PhotoSlotType`` STILL DOES. The strip used to be a
/// list of `PhotoSlotType` cases, which forced a new enum case for every extra
/// photo a category wanted — `tag_2`, `detail_2`, `detail_3`, `detail_4`,
/// `measurement_chest` and friends. That vocabulary could not grow without an
/// App Store release, and it could not say what the extra photo actually WAS:
/// a suit needs three tag shots (brand, size, trouser size) and `tag_2` names
/// none of them.
///
/// Migration 00587 split the answer into `item_photos.photo_type` (the physical
/// kind) and `item_photos.photo_role` (what it shows). A CaptureSlot is that
/// pair, plus the label and hint the resolved ``PhotoProfile`` supplies — so a
/// hat's interior slot reads "Sweatband" and a jacket's reads "Lining" without
/// either word being compiled in.
///
/// `PhotoSlotType` keeps its job: it is the capture-time vocabulary that owns
/// the SF Symbol, the storage bucket and the sensitivity rule. This type wraps
/// it rather than replacing it.
///
/// IDENTITY IS THE PAIR, NOTHING ELSE. `==` and `hash` read only ``storageKey``,
/// so a slot rebuilt from a draft or from a different profile still matches the
/// one already in the strip. If labels took part in equality, a profile arriving
/// from the network mid-session would silently orphan every photo already
/// captured under the bundled fallback's wording.
public struct CaptureSlot: Hashable, Identifiable, Sendable {
    /// The physical capture kind — SF Symbol, bucket, sensitivity, server
    /// `photo_type`.
    public let type: PhotoSlotType
    /// The `item_photos.photo_role` qualifier, or nil for a slot that takes
    /// none. `nil` and `""` are the same thing and normalise to nil.
    public let role: String?
    /// Category-specific display label from the profile.
    public let label: String
    /// One-line capture guidance from the profile.
    public let hint: String
    /// Must be filled before the item can advance. Front + Back only, in
    /// practice — see ``PhotoIntakeStore.allRequiredFilled``.
    public let isBlocking: Bool

    public init(
        type: PhotoSlotType,
        role: String? = nil,
        label: String? = nil,
        hint: String? = nil,
        isBlocking: Bool? = nil
    ) {
        self.type = type
        let trimmed = role?.trimmingCharacters(in: .whitespaces)
        self.role = (trimmed?.isEmpty ?? true) ? nil : trimmed
        self.label = label ?? type.label
        self.hint = hint ?? type.hint
        self.isBlocking = isBlocking ?? type.isRequired
    }

    /// Convenience for the pre-profile slots and for tests: the enum case's own
    /// label, hint and required flag, with no role.
    public init(_ type: PhotoSlotType) {
        self.init(type: type)
    }

    // MARK: - Identity

    /// Stable, round-trippable identity: `"front"`, or `"tag|size"`.
    ///
    /// The separator is `|` rather than the `:` that ``PhotoProfile/slotKey``
    /// uses, because this key is also a FILENAME in the draft directory and a
    /// value in a persisted pending mutation. `:` is legal on APFS but is
    /// rewritten to `/` by the Finder and has bitten path handling before.
    ///
    /// It keys on the enum's raw value, not on `serverPhotoType`, so the three
    /// defect slots stay distinct — they all write `photo_type = "defect"`.
    public var storageKey: String {
        guard let role else { return type.rawValue }
        return "\(type.rawValue)|\(role)"
    }

    public var id: String { storageKey }

    public static func == (lhs: CaptureSlot, rhs: CaptureSlot) -> Bool {
        lhs.storageKey == rhs.storageKey
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(storageKey)
    }

    /// Rebuilds a slot from a ``storageKey``. Returns nil for an unknown type
    /// so a draft written by a newer build is skipped rather than crashing.
    ///
    /// A bare `"front"` (no separator) is the pre-US-2470 draft shape and still
    /// decodes — drafts on disk at upgrade time must not be thrown away.
    public init?(storageKey: String) {
        let parts = storageKey.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        guard let first = parts.first, let type = PhotoSlotType(rawValue: String(first)) else {
            return nil
        }
        self.init(type: type, role: parts.count > 1 ? String(parts[1]) : nil)
    }

    // MARK: - Pass-throughs

    /// The `item_photos.photo_type` this slot writes.
    public var serverPhotoType: String { type.serverPhotoType }
    public var systemImage: String { type.systemImage }
    public var isSensitive: Bool { type.isSensitive }
    public var storageBucket: String { type.storageBucket }

    /// A garment TAG close-up, whatever role it carries — the AI extract waits
    /// on these (see `AIExtractionManager.waitForRequiredUploads`).
    public var isTagSlot: Bool { type.isTagSlot }

    /// US-2135: the long-edge cap this slot's upload is compressed to.
    ///
    /// iOS compresses everything to 1600px, and that was LOWERED there
    /// deliberately for upload speed on mobile data — a real tradeoff, not an
    /// oversight, which is why this raises the cap only for the slots where fine
    /// detail IS the evidence rather than raising it globally.
    ///
    /// Mirrors `MACRO_UPLOAD_MAX_WIDTH_PX` in `src/lib/macro-photo-quality.ts`,
    /// keyed on `serverPhotoType` so the two sides use the same key. The numbers
    /// are pinned against that file by `src/test/ios-upload-caps-parity.test.ts`
    /// — two copies of a resolution table drift silently, and the symptom is a
    /// grader quietly getting less to read on one platform.
    ///
    /// Authenticity slots get the most: the tell IS the fine detail — a struck
    /// serial, a maker's mark, stitch pitch. Sized against the 10MB byte ceiling
    /// both clients enforce.
    public var uploadMaxLongEdge: CGFloat {
        switch serverPhotoType {
        case "serial", "marking", "surface", "corner", "sole": 3600
        case "tag", "label", "detail", "defect", "interior", "certificate": 3000
        default: PhotoCompressor.defaultMaxLongEdge
        }
    }

    /// True for the defect slots, which reveal one at a time.
    public var isDefect: Bool { PhotoSlotType.defects.contains(type) }

    // MARK: - Pre-profile defaults

    /// The strip before any profile resolves: front, back, tag, detail.
    ///
    /// Kept as a real fallback rather than an empty list because
    /// ``PhotoProfileStore`` starts on a bundled table and only later swaps in
    /// the server's — a strip that rendered nothing for the first frame would
    /// be a visible flash on every launch.
    public static let defaults: [CaptureSlot] = PhotoSlotType.defaultSlots.map { CaptureSlot($0) }

    /// The blocking set. Front + Back, and deliberately not tag/detail: many
    /// garments have no readable tag.
    public static let blocking: [CaptureSlot] = PhotoSlotType.required.map { CaptureSlot($0) }

    /// How many slots the strip shows before the seller opens "Add more".
    /// Four, because that is what it has always shown and the number is a
    /// thumb-reach decision, not a taxonomy one.
    public static let defaultStripSize = 4

    /// The four pre-profile slots by name, so `.front` still reads as `.front`
    /// at a call site that wants a CaptureSlot. These are the UNROLED pairs —
    /// a profile's tag slot is `tag|brand`, which is deliberately NOT equal to
    /// ``CaptureSlot/tag``. Compare on ``serverPhotoType`` or ``isTagSlot`` when
    /// you mean "any tag shot".
    public static let front = CaptureSlot(PhotoSlotType.front)
    public static let back = CaptureSlot(PhotoSlotType.back)
    public static let tag = CaptureSlot(PhotoSlotType.tag)
    public static let detail = CaptureSlot(PhotoSlotType.detail)
    public static let measurementCard = CaptureSlot(PhotoSlotType.measurementCard)

    /// The three defect slots, in reveal order.
    public static func defectSlots(label: String, hint: String) -> [CaptureSlot] {
        PhotoSlotType.defects.map {
            CaptureSlot(type: $0, role: nil, label: label, hint: hint, isBlocking: false)
        }
    }
}

// MARK: - Profile → slots

public extension PhotoRole {
    /// This profile role as a capture slot, or nil when the app has no capture
    /// case for the type.
    ///
    /// RETIRED TYPES ARE REFUSED HERE (US-2470 AC4). `tag_2`, `detail_2..4` and
    /// `measurement_*` remain legal values forever — Postgres cannot drop an
    /// enum value and historical rows point at them — but a NEW capture must
    /// never write one. Refusing at the single point where a profile becomes a
    /// slot means no capture surface has to remember the rule.
    var captureSlot: CaptureSlot? {
        guard !FlipdeskPhotoType.isRetired(type) else { return nil }
        guard let slotType = PhotoSlotType(serverType: type) else { return nil }
        return CaptureSlot(
            type: slotType,
            role: role,
            label: label,
            hint: hint,
            isBlocking: required && slotType.isRequired
        )
    }
}

public extension PhotoProfile {
    /// Every non-defect role as a capture slot, in PROFILE ORDER.
    ///
    /// That order is the contract: it is the gallery order on the web and index
    /// 0 is the eBay cover image, so `PhotoUploadService` derives `sort_order`
    /// from a photo's position in this list. Defects are excluded because they
    /// reveal one at a time through their own mechanism.
    ///
    /// DEDUPED, first occurrence wins. The profile table is server data this
    /// client did not author, and `ForEach` over two entries with the same id is
    /// a SwiftUI runtime fault — a duplicated role would crash the camera rather
    /// than render one extra menu row. Same reasoning as the retag picker's
    /// dedupe in `PhotoManagerView.changeTypeMenu`.
    var captureSlots: [CaptureSlot] {
        var seen = Set<String>()
        return roles
            .filter { $0.type != "defect" }
            .compactMap { $0.captureSlot }
            .filter { seen.insert($0.storageKey).inserted }
    }

    /// Slots shown in the strip from the start: every required role, then one
    /// slot of each further KIND until the strip is full.
    ///
    /// Not simply "the required ones" — the server profiles mark only front and
    /// back required, and a strip that opened on two slots would hide the tag
    /// and detail shots sellers are meant to reach for without thinking. Not
    /// simply "the first four" either: clothing's role order is front, back,
    /// tag:brand, tag:size, so that would offer two tag slots and no detail.
    ///
    /// One of each kind up front, the variants behind "Add more". For clothing
    /// that resolves to front, back, tag, detail — the strip this has always
    /// shown — and for a watch or a card it resolves to that category's own
    /// four without either list being written down twice.
    var defaultCaptureSlots: [CaptureSlot] {
        let all = captureSlots
        guard !all.isEmpty else { return CaptureSlot.defaults }
        var out: [CaptureSlot] = []
        var seenTypes = Set<String>()
        for slot in all where slot.isBlocking {
            out.append(slot)
            seenTypes.insert(slot.serverPhotoType)
        }
        for slot in all {
            guard out.count < CaptureSlot.defaultStripSize else { break }
            guard !seenTypes.contains(slot.serverPhotoType) else { continue }
            out.append(slot)
            seenTypes.insert(slot.serverPhotoType)
        }
        return out.isEmpty ? CaptureSlot.defaults : out
    }

    /// Slots offered behind "Add more": everything else, in profile order.
    var optionalCaptureSlots: [CaptureSlot] {
        let shown = Set(defaultCaptureSlots)
        return captureSlots.filter { !shown.contains($0) }
    }

    /// The defect slots this profile allows, already carrying its wording.
    var defectCaptureSlots: [CaptureSlot] {
        guard let defect = roles.first(where: { $0.type == "defect" }) else { return [] }
        return CaptureSlot.defectSlots(label: defect.label, hint: defect.hint)
    }

    /// `sort_order` for a slot: its index among ``captureSlots``.
    ///
    /// Returns nil for a slot the profile does not list — a defect, or a slot
    /// revealed under a different profile earlier in the session. The caller
    /// sorts those AFTER the profile's own, which is where the web puts them.
    func sortIndex(of slot: CaptureSlot) -> Int? {
        captureSlots.firstIndex(of: slot)
    }
}
