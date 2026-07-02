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

    /// US-1519: serial I/O queue. Every mutation runs through it in submission
    /// order, so the per-shutter delta writes (async) can never be reordered
    /// against an explicit `save`/`clear` (sync).
    private static let ioQueue = DispatchQueue(
        label: "com.gradethread.app.photo-draft-io", qos: .utility
    )

    private static var directory: URL? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return base?.appendingPathComponent(dirName, isDirectory: true)
    }

    private struct Manifest: Codable {
        struct Entry: Codable { let slot: String; let filename: String }
        let entries: [Entry]
        let savedAt: Date
    }

    private static func fileName(for slot: PhotoSlotType) -> String {
        "photo-\(slot.rawValue).jpg"
    }

    /// Persist the current capture set. Overwrites the single draft.
    /// Synchronous full rewrite — kept for explicit one-shot callers and tests;
    /// the capture flow's per-shutter autosave uses ``update(from:to:)``, which
    /// writes only the changed slot and stays off the calling thread.
    static func save(photos: [PhotoSlotType: PhotoCapture]) {
        ioQueue.sync { writeAll(photos: photos) }
    }

    /// US-1519: incremental per-shutter persist. The original autosave path
    /// `clear()`ed and synchronously rewrote EVERY staged JPEG on the MainActor
    /// per capture — ~4MB of sync I/O by photo 8, a visibly growing post-shutter
    /// hitch. This diffs by ``PhotoCapture/id`` (cheap; a retake mints a new id)
    /// and hands only the changed slot's bytes to the serial utility queue.
    static func update(
        from old: [PhotoSlotType: PhotoCapture],
        to new: [PhotoSlotType: PhotoCapture]
    ) {
        guard !new.isEmpty else {
            ioQueue.async { removeAll() }
            return
        }
        let changed = new.filter { slot, capture in old[slot]?.id != capture.id }
        let removedSlots = old.keys.filter { new[$0] == nil }
        guard !changed.isEmpty || !removedSlots.isEmpty else { return }
        let allSlots = Array(new.keys)
        ioQueue.async {
            writeDelta(changed: changed, removedSlots: removedSlots, allSlots: allSlots)
        }
    }

    // MARK: Queue-confined implementation

    private static func writeAll(photos: [PhotoSlotType: PhotoCapture]) {
        removeAll()
        guard !photos.isEmpty, let dir = directory else { return }
        ensureDirectory(dir)
        var entries: [Manifest.Entry] = []
        for (slot, capture) in photos {
            let filename = fileName(for: slot)
            let url = dir.appendingPathComponent(filename)
            // Encrypt at rest (consistent with US-658) — these are unsubmitted
            // garment photos sitting on disk.
            if (try? capture.imageData.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil {
                entries.append(Manifest.Entry(slot: slot.rawValue, filename: filename))
            }
        }
        writeManifest(entries: entries, in: dir)
    }

    private static func writeDelta(
        changed: [PhotoSlotType: PhotoCapture],
        removedSlots: [PhotoSlotType],
        allSlots: [PhotoSlotType]
    ) {
        guard let dir = directory else { return }
        ensureDirectory(dir)
        for (slot, capture) in changed {
            try? capture.imageData.write(
                to: dir.appendingPathComponent(fileName(for: slot)),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        }
        for slot in removedSlots {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(fileName(for: slot)))
        }
        // The manifest lists the full current slot set (filenames are
        // slot-deterministic). A slot whose write failed is listed but absent on
        // disk — restore already skips unreadable entries gracefully.
        let entries = allSlots.map { Manifest.Entry(slot: $0.rawValue, filename: fileName(for: $0)) }
        writeManifest(entries: entries, in: dir)
    }

    private static func ensureDirectory(_ dir: URL) {
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
    }

    private static func writeManifest(entries: [Manifest.Entry], in dir: URL) {
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

    private static func removeAll() {
        guard let dir = directory else { return }
        try? FileManager.default.removeItem(at: dir)
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
        // Sync through the queue so a discard can't be overtaken by a queued
        // delta write that would resurrect the draft (US-1519).
        ioQueue.sync { removeAll() }
    }

    /// Test seam (US-1519): blocks until every queued delta write has landed,
    /// so tests can assert on-disk state after the async `update(from:to:)`.
    static func flushWrites() {
        ioQueue.sync {}
    }
}
