import Combine
import Foundation

/// Drives the AutoLister generate pipeline for a reviewed batch of groups:
///   1. create an `inventory_items` row per group,
///   2. upload its photos (cover → front, rest → detail) via the shared
///      `PhotoUploadService`,
///   3. best-effort `/classify-photos` → write cover/role ordering back onto the
///      `item_photos` rows,
///   4. submit the item ids for generation (handing the batch lifecycle to an
///      embedded `AutolisterBatchStore`), and
///   5. best-effort `/photo-qa` for reshoot nudges.
///
/// Owns an `AutolisterBatchStore` and forwards its change notifications so a
/// single `@StateObject` of this generator drives the whole queue screen.
@MainActor
final class AutoListerGenerator: ObservableObject {

    enum Prep: Equatable {
        case idle
        case running(done: Int, total: Int)
        case failed(String)
        case finished
    }

    @Published private(set) var prep: Prep = .idle

    /// Batch lifecycle (submit/poll/retry/photo-qa). Exposed for the queue UI.
    let batch: AutolisterBatchStore

    private let service: AutolisterBatching
    private var bridge: AnyCancellable?

    init(service: AutolisterBatching = AutolisterService()) {
        self.service = service
        self.batch = AutolisterBatchStore(service: service)
        // Re-publish nested batch-store changes so views observing only this
        // generator still update when jobs/phase/photoQa change.
        bridge = batch.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }

    /// Run the full pipeline once. Subsequent calls are ignored (the queue view
    /// kicks this off in `.task`, which can re-fire).
    func run(
        groups: [PreparedGroup],
        uploadService: PhotoUploadService,
        uploadStore: PhotoUploadStore
    ) async {
        guard case .idle = prep, !groups.isEmpty else { return }

        let userId: String
        do {
            userId = try await SupabaseShared.client.auth.session.user.id.uuidString
        } catch {
            prep = .failed("You need to be signed in to generate listings.")
            return
        }

        prep = .running(done: 0, total: groups.count)
        var itemIds: [String] = []

        for (index, group) in groups.enumerated() {
            do {
                let itemId = try await createItem(userId: userId)
                let scheduled = scheduleUploads(
                    group: group, itemId: itemId, userId: userId,
                    uploadService: uploadService, uploadStore: uploadStore
                )
                await waitForUploads(itemId: itemId, uploadStore: uploadStore)
                await applyClassification(group: group, scheduled: scheduled)
                itemIds.append(itemId)
                prep = .running(done: index + 1, total: groups.count)
            } catch {
                prep = .failed(message(error))
                return
            }
        }

        prep = .finished
        await batch.submit(itemIds: itemIds)
        // Non-fatal reshoot nudges; surfaced in the queue.
        await batch.runPhotoQa(itemIds: itemIds)
    }

    // MARK: - Steps

    private func createItem(userId: String) async throws -> String {
        struct ItemInsert: Encodable {
            let user_id: String
            let title: String
            let status: String
        }
        struct Row: Decodable { let id: String }
        // Mirrors PhotoIntakeView.createDraftInventoryItem — a minimal cataloged
        // row; AutoLister generation fills in the real title/specifics.
        let rows: [Row] = try await SupabaseShared.client
            .from("inventory_items")
            .insert(ItemInsert(user_id: userId, title: "Untitled item", status: "cataloged"),
                    returning: .representation)
            .select("id")
            .execute()
            .value
        guard let id = rows.first?.id else {
            throw EdgeAPIError.serverError(detail: "No id returned from item insert.")
        }
        return id
    }

    private struct ScheduledPhoto { let id: String; let storagePath: String }

    private func scheduleUploads(
        group: PreparedGroup,
        itemId: String,
        userId: String,
        uploadService: PhotoUploadService,
        uploadStore: PhotoUploadStore
    ) -> [ScheduledPhoto] {
        var scheduled: [ScheduledPhoto] = []
        // group.photos is already cover-first.
        for (idx, photo) in group.photos.enumerated() {
            let slot: PhotoSlotType = idx == 0 ? .front : .detail
            guard let taskId = uploadService.schedule(
                capture: photo, slot: slot, inventoryItemId: itemId,
                userId: userId, sortOrder: idx
            ) else { continue }
            if let path = uploadStore.tasks[taskId]?.storagePath {
                scheduled.append(ScheduledPhoto(id: photo.id.uuidString, storagePath: path))
            }
        }
        return scheduled
    }

    /// Poll the upload store until this item's scheduled uploads all reach a
    /// terminal state (or a wall-clock cap). Mirrors AIExtractView.waitForUploads.
    private func waitForUploads(itemId: String, uploadStore: PhotoUploadStore) async {
        let deadline = Date.now.addingTimeInterval(90)
        while Date.now < deadline {
            let tasks = uploadStore.tasks(inventoryItemId: itemId)
            if !tasks.isEmpty, tasks.allSatisfy(\.isTerminal) { return }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    /// Best-effort cover/role classification + write-back. Any failure here is
    /// swallowed — the listing still generates from the uploaded photos.
    private func applyClassification(group: PreparedGroup, scheduled: [ScheduledPhoto]) async {
        guard !scheduled.isEmpty else { return }
        let inputs = scheduled.map { ClassifyPhotoInput(id: $0.id, storagePath: $0.storagePath) }
        guard let res = try? await service.classifyPhotos(inputs) else { return }

        let pathById = Dictionary(scheduled.map { ($0.id, $0.storagePath) },
                                  uniquingKeysWith: { a, _ in a })
        let patches = Self.photoPatches(
            coverId: res.coverId,
            roles: res.roles,
            orderedIds: group.photos.map { $0.id.uuidString },
            pathById: pathById
        )
        struct Patch: Encodable { let sort_order: Int; let photo_type: String }
        for p in patches {
            _ = try? await SupabaseShared.client
                .from("item_photos")
                .update(Patch(sort_order: p.sortOrder, photo_type: p.photoType))
                .eq("storage_path", value: p.storagePath)
                .execute()
        }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

// MARK: - Pure classification write-back

extension AutoListerGenerator {
    struct PhotoPatch: Equatable {
        let storagePath: String
        let sortOrder: Int
        let photoType: String
    }

    /// PURE: resolve the item_photos updates from a classify result. The chosen
    /// cover sorts first (`sort_order` 0); the rest keep their group order. Each
    /// photo's `photo_type` is its classified role, defaulting to front (cover)
    /// or detail. Photos with no uploaded path are skipped.
    nonisolated static func photoPatches(
        coverId: String?,
        roles: [String: String],
        orderedIds: [String],
        pathById: [String: String]
    ) -> [PhotoPatch] {
        var order = orderedIds
        if let coverId, order.contains(coverId) {
            order.removeAll { $0 == coverId }
            order.insert(coverId, at: 0)
        }
        var patches: [PhotoPatch] = []
        for (i, id) in order.enumerated() {
            guard let path = pathById[id] else { continue }
            let role = roles[id] ?? (i == 0 ? "front" : "detail")
            patches.append(PhotoPatch(storagePath: path, sortOrder: i, photoType: role))
        }
        return patches
    }
}
