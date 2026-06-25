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
    /// Legacy UserDefaults key (US-646). Drafts now live in a file-protected
    /// store (US-1218); this key is only read once to migrate, then removed.
    private static let legacyKey = "com.gradethread.app.intakeDraft"
    private static let dirName = "intake-details-draft"

    private static var directory: URL? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return base?.appendingPathComponent(dirName, isDirectory: true)
    }

    private static var fileURL: URL? {
        directory?.appendingPathComponent("draft.json")
    }

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
        guard let dir = directory, let url = fileURL,
              let data = try? JSONEncoder().encode(draft) else { return }
        // Encrypt at rest (US-1218): notes/cost/names are free-text PII and must
        // not sit in plaintext UserDefaults or unencrypted backups. Mirrors the
        // US-658 photo posture (PhotoDraftStore).
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func load() -> Draft? {
        migrateLegacyIfNeeded()
        guard let url = fileURL,
              let data = try? Data(contentsOf: url),
              let draft = try? JSONDecoder().decode(Draft.self, from: data),
              draft.hasContent else { return nil }
        return draft
    }

    /// One-time migration of a US-646 UserDefaults draft into the file-protected
    /// store, then deletes the plaintext key so no PII lingers (US-1218).
    private static func migrateLegacyIfNeeded() {
        guard let legacyData = UserDefaults.standard.data(forKey: legacyKey) else { return }
        defer { UserDefaults.standard.removeObject(forKey: legacyKey) }
        guard let dir = directory, let url = fileURL,
              (try? Data(contentsOf: url)) == nil,
              let draft = try? JSONDecoder().decode(Draft.self, from: legacyData),
              draft.hasContent,
              let data = try? JSONEncoder().encode(draft) else { return }
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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
        UserDefaults.standard.removeObject(forKey: legacyKey)
        if let url = fileURL {
            try? FileManager.default.removeItem(at: url)
        }
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
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
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
            // Encrypt the manifest too (US-1218): it sits beside protected photos
            // but listed only filenames — still keep the whole draft dir consistent.
            try? data.write(
                to: dir.appendingPathComponent("manifest.json"),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
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
