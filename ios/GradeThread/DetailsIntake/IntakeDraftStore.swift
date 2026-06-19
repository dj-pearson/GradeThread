import Foundation
import UIKit

/// US-646 — autosave / draft recovery for in-progress intake.
///
/// Two halves, both single-draft (one in-progress details item + one in-progress
/// photo set) so the user gets a clear "resume?" prompt rather than a pile of
/// orphaned drafts:
///   - ``IntakeDraftStore`` persists the typed ``IntakeFormState`` fields to
///     UserDefaults as they change, and restores them after a background-kill.
///   - ``PhotoDraftStore`` persists captured photo JPEGs (+ a slot manifest) to
///     a drafts directory and restores them into a ``PhotoIntakeStore``.
///
/// Both are cleared on a successful save or an explicit discard.
enum IntakeDraftStore {
    private static let key = "com.gradethread.app.intakeDraft"

    /// Codable snapshot of the form. Enum fields are stored as raw values so a
    /// future enum case can't break decoding (falls back to the default).
    struct Draft: Codable, Equatable {
        var title = ""
        var sku = ""
        var brand = ""
        var style = ""
        var size = ""
        var color = ""
        var material = ""
        var category = FlipdeskCategory.clothing.rawValue
        var status = IntakeStatus.cataloged.rawValue
        var sourceId: String?
        var container = ""
        var sourcedBy = ""
        var purchaseDate = Date.now
        var purchasePriceText = ""
        var notes = ""
        var savedAt = Date.now

        /// Worth restoring only when the user actually entered something beyond
        /// the defaults — an empty form draft is noise.
        var hasContent: Bool {
            !title.trimmingCharacters(in: .whitespaces).isEmpty
                || ![sku, brand, style, size, color, material, container, sourcedBy, notes, purchasePriceText]
                    .allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty }
        }
    }

    @MainActor
    static func save(_ form: IntakeFormState) {
        var draft = Draft()
        draft.title = form.title
        draft.sku = form.sku
        draft.brand = form.brand
        draft.style = form.style
        draft.size = form.size
        draft.color = form.color
        draft.material = form.material
        draft.category = form.category.rawValue
        draft.status = form.status.rawValue
        draft.sourceId = form.sourceId
        draft.container = form.container
        draft.sourcedBy = form.sourcedBy
        draft.purchaseDate = form.purchaseDate
        draft.purchasePriceText = form.purchasePriceText
        draft.notes = form.notes
        draft.savedAt = .now
        guard draft.hasContent else { clear(); return }
        if let data = try? JSONEncoder().encode(draft) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    static func load() -> Draft? {
        guard let data = UserDefaults.standard.data(forKey: key),
              let draft = try? JSONDecoder().decode(Draft.self, from: data),
              draft.hasContent else { return nil }
        return draft
    }

    @MainActor
    static func apply(_ draft: Draft, to form: IntakeFormState) {
        form.title = draft.title
        form.sku = draft.sku
        form.brand = draft.brand
        form.style = draft.style
        form.size = draft.size
        form.color = draft.color
        form.material = draft.material
        form.category = FlipdeskCategory(rawValue: draft.category) ?? .clothing
        form.status = IntakeStatus(rawValue: draft.status) ?? .cataloged
        form.sourceId = draft.sourceId
        form.container = draft.container
        form.sourcedBy = draft.sourcedBy
        form.purchaseDate = draft.purchaseDate
        form.purchasePriceText = draft.purchasePriceText
        form.notes = draft.notes
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

/// File-backed persistence of in-progress capture photos (US-646).
enum PhotoDraftStore {
    private static let dirName = "intake-photo-draft"

    private static var directory: URL? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return base?.appendingPathComponent(dirName, isDirectory: true)
    }

    private struct Manifest: Codable {
        struct Entry: Codable { let slot: String; let filename: String }
        let entries: [Entry]
        let savedAt: Date
    }

    /// Persist the current capture set. Overwrites the single draft.
    static func save(photos: [PhotoSlotType: PhotoCapture]) {
        guard let dir = directory else { return }
        clear()
        guard !photos.isEmpty else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var entries: [Manifest.Entry] = []
        for (slot, capture) in photos {
            let filename = "photo-\(slot.rawValue).jpg"
            let url = dir.appendingPathComponent(filename)
            // Encrypt at rest (consistent with US-658) — these are unsubmitted
            // garment photos sitting on disk.
            if (try? capture.imageData.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil {
                entries.append(Manifest.Entry(slot: slot.rawValue, filename: filename))
            }
        }
        let manifest = Manifest(entries: entries, savedAt: .now)
        if let data = try? JSONEncoder().encode(manifest) {
            try? data.write(to: dir.appendingPathComponent("manifest.json"), options: [.atomic])
        }
    }

    /// True when a non-empty photo draft exists on disk.
    static func hasDraft() -> Bool {
        guard let dir = directory,
              let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else { return false }
        return !manifest.entries.isEmpty
    }

    /// Restore the persisted captures into a fresh store (US-996).
    ///
    /// The file reads and JPEG decodes run off the main actor on a detached
    /// task: a 10-photo draft is up to ~10 multi-MB JPEGs, and synchronously
    /// reading + fully decoding them on `@MainActor` hitched the UI. We also
    /// build the slot thumbnails *downsampled* (~160px long edge) via
    /// ImageIO rather than keeping full-resolution `UIImage`s resident — the
    /// strip cell never needs more, and full-res thumbnails wasted memory.
    /// Only the `setPhoto` mutations hop back to the main actor.
    @MainActor
    static func restore(into store: PhotoIntakeStore) async {
        guard let dir = directory,
              let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else { return }
        let restored = await Task.detached(priority: .userInitiated) {
            () -> [(PhotoSlotType, PhotoCapture)] in
            var out: [(PhotoSlotType, PhotoCapture)] = []
            for entry in manifest.entries {
                autoreleasepool {
                    guard let slot = PhotoSlotType(rawValue: entry.slot),
                          let bytes = try? Data(contentsOf: dir.appendingPathComponent(entry.filename)),
                          let thumb = ThumbnailLoader.downsample(
                              data: bytes,
                              maxPixel: PhotoCompressor.defaultThumbnailLongEdge
                          ) else { return }
                    out.append((slot, PhotoCapture(imageData: bytes, thumbnail: thumb, source: .library)))
                }
            }
            return out
        }.value
        for (slot, capture) in restored {
            store.setPhoto(capture, for: slot)
        }
    }

    static func clear() {
        guard let dir = directory else { return }
        try? FileManager.default.removeItem(at: dir)
    }
}
