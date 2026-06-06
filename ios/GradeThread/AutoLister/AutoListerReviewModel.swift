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
    @Published private(set) var isImporting = false

    var isEmpty: Bool { photosById.isEmpty }
    var totalPhotos: Int { photosById.count }

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
        defer { isImporting = false }
        var captures: [PhotoCapture] = []
        for result in results {
            guard let image = await result.loadImage(),
                  let output = PhotoCompressor.compress(image) else { continue }
            captures.append(
                PhotoCapture(
                    imageData: output.imageData,
                    thumbnail: output.thumbnail,
                    capturedAt: result.creationDate() ?? .now,
                    source: .library
                )
            )
        }
        ingest(captures)
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

    /// Re-run capture-time clustering over all imported photos.
    func regroupAll() {
        let groupables = photosById.values.map {
            GroupablePhoto(id: $0.id.uuidString, capturedAt: $0.capturedAt)
        }
        groups = PhotoGrouping.autoGroup(groupables).compactMap { auto in
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
        for i in groups.indices { groups[i].photoIds.removeAll { $0 == photoId } }
        normalize()
    }

    func deleteGroup(_ groupId: UUID) {
        guard let g = groups.first(where: { $0.id == groupId }) else { return }
        for pid in g.photoIds { photosById[pid] = nil }
        groups.removeAll { $0.id == groupId }
    }

    /// Drop empty groups and repair any cover that no longer points at a member.
    private func normalize() {
        groups.removeAll { $0.photoIds.isEmpty }
        for i in groups.indices where !groups[i].photoIds.contains(groups[i].coverId) {
            if let first = groups[i].photoIds.first { groups[i].coverId = first }
        }
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
