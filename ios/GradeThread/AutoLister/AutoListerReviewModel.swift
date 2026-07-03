import PhotosUI
import SwiftUI
import UIKit

/// One reviewable item group: the photos that will become a single listing,
/// plus the chosen cover. Carries its own identity so SwiftUI diffing and the
/// merge/split edits stay stable across regrouping.
struct ReviewGroup: Identifiable, Equatable {
    let id: UUID
    var photoIds: [UUID]
    var coverId: UUID
}

/// A group prepared for generation: photos ordered with the cover first. Phase C
/// consumes this to create the item + upload its photos.
struct PreparedGroup {
    let coverId: UUID
    let photos: [PhotoCapture]
}

/// View-model for the AutoLister capture + review screen. Holds the imported
/// photos and their grouping, and the merge/split/cover/delete edits. The edit
/// logic is pure (no UI, no network) so it's unit-tested directly; `importPicks`
/// is the only async/PhotoKit seam.
@MainActor
final class AutoListerReviewModel: ObservableObject {

    @Published private(set) var photosById: [UUID: PhotoCapture] = [:]
    @Published private(set) var groups: [ReviewGroup] = []
    /// US-1548: 64-bit dHash per photo, computed off-main during import. Feeds
    /// the visual merge pass; photos that couldn't hash simply don't participate.
    private var hashesById: [UUID: UInt64] = [:]
    @Published private(set) var isImporting = false
    /// Set when a batch import yields no usable photos (US-1116) — drives a
    /// retryable error state instead of silently dropping back to the empty
    /// state, which reads as "nothing happened".
    @Published private(set) var importError: String?
    /// Transient failure (e.g. a rotate that couldn't re-encode) surfaced as an
    /// alert; the review list stays put.
    @Published var actionError: String?

    var isEmpty: Bool { photosById.isEmpty }
    var totalPhotos: Int { photosById.count }

    /// Photos imported but auto-grouping produced nothing to review (US-1116).
    var hasPhotosButNoGroups: Bool { !photosById.isEmpty && groups.isEmpty }

    /// Ready to generate when there's at least one group and none is empty.
    var canGenerate: Bool { !groups.isEmpty && groups.allSatisfy { !$0.photoIds.isEmpty } }

    func photos(in group: ReviewGroup) -> [PhotoCapture] {
        group.photoIds.compactMap { photosById[$0] }
    }

    func displayIndex(of group: ReviewGroup) -> Int {
        (groups.firstIndex(where: { $0.id == group.id }) ?? 0) + 1
    }

    // MARK: - Import

    /// Load PHPicker results into `PhotoCapture`s (compress + EXIF capture time,
    /// same path as `PhotoIntakeView.ingestLibraryPicks`) then (re)group. Picks
    /// that can't materialize (e.g. still in iCloud) are skipped.
    func importPicks(_ results: [PHPickerResult]) async {
        isImporting = true
        importError = nil
        defer { isImporting = false }
        var captures: [PhotoCapture] = []
        for result in results {
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(image) else { continue }
            let capture = PhotoCapture(
                imageData: output.imageData,
                thumbnail: output.thumbnail,
                capturedAt: result.creationDate() ?? .now,
                source: .library,
                // US-1547: the original filename drives sequence grouping and
                // is persisted as item_photos.original_filename at upload.
                sourceName: result.itemProvider.suggestedName
            )
            captures.append(capture)
            // US-1548: hash for the visual merge pass — off-main, alongside the
            // compression this import already does per photo.
            if let hash = await Task.detached(priority: .userInitiated, operation: {
                DHash.compute(image)
            }).value {
                hashesById[capture.id] = hash
            }
        }
        ingest(captures)
        // The user picked photos but none could be materialized (still syncing
        // from iCloud, undecodable). Surface a retryable error rather than the
        // empty state, which would look like the import never ran (US-1116).
        if captures.isEmpty && !results.isEmpty {
            importError = results.count == 1
                ? "Couldn't import that photo. It may still be downloading from iCloud — try again."
                : "Couldn't import those photos. They may still be downloading from iCloud — try again."
        }
    }

    /// Add captures and re-derive groups from capture time. Test seam (callers
    /// pass synthetic `PhotoCapture`s without PhotoKit). Note: a fresh ingest
    /// re-runs auto-grouping over everything, discarding prior manual edits —
    /// acceptable for v1's "import once, then review" flow; the user can also
    /// hit "Auto-group" to reset deliberately.
    func ingest(_ captures: [PhotoCapture]) {
        for c in captures { photosById[c.id] = c }
        regroupAll()
    }

    // MARK: - Grouping

    /// Re-run clustering over all imported photos: capture-time bursts, the
    /// US-1547 filename-sequence signal for timeless photos, and the US-1548
    /// dHash visual merge pass over whatever hashed during import.
    func regroupAll() {
        let groupables = photosById.values.map {
            GroupablePhoto(
                id: $0.id.uuidString,
                capturedAt: $0.capturedAt,
                sourceName: $0.sourceName
            )
        }
        // GroupablePhoto ids are lowercase-normalized? UUID.uuidString is
        // uppercase; the hash map below keys by the SAME uuidString, so the
        // round-trip stays consistent either way.
        let hashes = Dictionary(
            hashesById.map { ($0.key.uuidString, $0.value) },
            uniquingKeysWith: { a, _ in a }
        )
        groups = PhotoGrouping.autoGroup(groupables, hashes: hashes).compactMap { auto in
            let ids = auto.photoIds.compactMap(UUID.init(uuidString:))
            guard let cover = UUID(uuidString: auto.coverId) ?? ids.first else { return nil }
            return ReviewGroup(id: UUID(), photoIds: ids, coverId: cover)
        }
    }

    // MARK: - Edits

    func setCover(_ photoId: UUID, in groupId: UUID) {
        guard let gi = groups.firstIndex(where: { $0.id == groupId }),
              groups[gi].photoIds.contains(photoId) else { return }
        groups[gi].coverId = photoId
        // Keep the cover first so the listing hero is unambiguous.
        groups[gi].photoIds.removeAll { $0 == photoId }
        groups[gi].photoIds.insert(photoId, at: 0)
    }

    /// Move a photo to another group, or to a brand-new group when `target` is nil
    /// (split). Moving all of a group's photos into another effectively merges.
    func movePhoto(_ photoId: UUID, from sourceId: UUID, to targetId: UUID?) {
        guard let si = groups.firstIndex(where: { $0.id == sourceId }) else { return }
        groups[si].photoIds.removeAll { $0 == photoId }
        if let targetId, let ti = groups.firstIndex(where: { $0.id == targetId }) {
            groups[ti].photoIds.append(photoId)
        } else {
            groups.append(ReviewGroup(id: UUID(), photoIds: [photoId], coverId: photoId))
        }
        normalize()
    }

    func removePhoto(_ photoId: UUID) {
        photosById[photoId] = nil
        hashesById[photoId] = nil
        for i in groups.indices { groups[i].photoIds.removeAll { $0 == photoId } }
        normalize()
    }

    func deleteGroup(_ groupId: UUID) {
        guard let g = groups.first(where: { $0.id == groupId }) else { return }
        for pid in g.photoIds {
            photosById[pid] = nil
            hashesById[pid] = nil
        }
        groups.removeAll { $0.id == groupId }
    }

    /// Drop empty groups and repair any cover that no longer points at a member.
    private func normalize() {
        groups.removeAll { $0.photoIds.isEmpty }
        for i in groups.indices where !groups[i].photoIds.contains(groups[i].coverId) {
            if let first = groups[i].photoIds.first { groups[i].coverId = first }
        }
    }

    // MARK: - Rotate

    /// Rotates an imported photo 90° in place, BEFORE it's uploaded. Re-encodes
    /// the JPEG + thumbnail off-main and swaps the capture back under the same
    /// id, so grouping and cover selection are untouched — the rotated bytes are
    /// simply what Phase C uploads. We bake rotation into the pixels (not EXIF)
    /// because eBay's image pipeline ignores orientation tags (same rationale as
    /// `PhotoRotateService` for already-uploaded photos). No-op if the capture is
    /// missing or its data can't be decoded.
    func rotate(_ photoId: UUID, clockwise: Bool) async {
        guard let capture = photosById[photoId],
              let image = UIImage(data: capture.imageData) else {
            actionError = "Couldn't rotate that photo."
            return
        }
        let rotated = PhotoRotateService.rotated(image, clockwise: clockwise)
        guard let output = await PhotoCompressor.compressOffMain(rotated) else {
            actionError = "Couldn't rotate that photo. Try again."
            return
        }
        photosById[photoId] = PhotoCapture(
            id: capture.id,
            imageData: output.imageData,
            thumbnail: output.thumbnail,
            capturedAt: capture.capturedAt,
            source: capture.source,
            // US-1547: rotation must not drop the provenance filename.
            sourceName: capture.sourceName
        )
        // US-1548: re-hash the rotated pixels (a 90° turn changes the dHash).
        hashesById[photoId] = await Task.detached(priority: .userInitiated, operation: {
            DHash.compute(rotated)
        }).value
    }

    // MARK: - Handoff

    /// Snapshot for the generate pipeline: each group's photos ordered cover-first.
    func preparedGroups() -> [PreparedGroup] {
        groups.map { g in
            let ordered = ([g.coverId] + g.photoIds.filter { $0 != g.coverId })
                .compactMap { photosById[$0] }
            return PreparedGroup(coverId: g.coverId, photos: ordered)
        }
    }
}
