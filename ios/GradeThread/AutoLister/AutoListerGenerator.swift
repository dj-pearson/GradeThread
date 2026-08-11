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
/// US-998: uploads for every group are scheduled UP FRONT so the shared
/// `PhotoUploadService` (cap `maxConcurrent`) overlaps them — a later group's
/// photos start transferring while earlier groups are still in flight, instead
/// of draining one group's uploads before the next is even scheduled. A single
/// wall-clock deadline then waits across the whole batch; if it elapses with
/// photos still pending, generation does NOT proceed silently — the user is
/// warned and can retry the uploads (or generate anyway).
///
/// Owns an `AutolisterBatchStore` and forwards its change notifications so a
/// single `@StateObject` of this generator drives the whole queue screen.
@MainActor
final class AutoListerGenerator: ObservableObject {

    /// How long the batch may make NO upload progress before it's called
    /// stalled (US-2373).
    ///
    /// This used to be a flat 90s cap on the whole batch, which quietly made
    /// bulk unusable: uploads run one at a time (`PhotoUploadService
    /// .maxConcurrent = 1`) at roughly a second each, so any batch over ~90
    /// photos — the exact case AutoLister exists for — ran out the clock while
    /// uploading perfectly well and dumped the seller on the "Uploads still
    /// finishing" screen. A stall timeout scales on its own: a 500-photo batch
    /// that keeps completing photos keeps going, and a genuinely wedged one is
    /// caught in 90 seconds either way.
    static let uploadStallTimeout: TimeInterval = 90

    /// Photo-level progress of the batch's uploads — the number that actually
    /// moves during a bulk run (items complete in clumps, photos one by one).
    struct UploadProgress: Equatable {
        var photosDone: Int
        var photosTotal: Int
        var itemsDone: Int
        var itemsTotal: Int

        var fraction: Double {
            photosTotal > 0 ? Double(photosDone) / Double(photosTotal) : 0
        }
    }

    /// Live upload counts while `prep` is `.running`; nil otherwise.
    @Published private(set) var uploadProgress: UploadProgress?

    enum Prep: Equatable {
        case idle
        case running(done: Int, total: Int)
        case failed(String)
        /// Upload deadline elapsed with `pending` of `total` items still
        /// missing one or more terminal photos. The user chooses to retry the
        /// uploads or generate anyway — generation never proceeds silently.
        case timedOut(pending: Int, total: Int)
        case finished
    }

    @Published private(set) var prep: Prep = .idle

    /// Batch lifecycle (submit/poll/retry/photo-qa). Exposed for the queue UI.
    let batch: AutolisterBatchStore

    private let service: AutolisterBatching
    private var bridge: AnyCancellable?

    /// One group that was created + had its photos scheduled. Retained so a
    /// post-timeout retry can re-drive the same uploads and classification.
    private struct PreparedItem {
        let itemId: String
        let group: PreparedGroup
        let scheduled: [ScheduledPhoto]
    }

    /// Retry context captured by `run`, consumed by `finishPreparation` and by
    /// the post-timeout `retryUploads` / `generateAnyway` actions.
    private var prepared: [PreparedItem] = []
    private var templateId: String?
    private weak var uploadStore: PhotoUploadStore?
    private var uploadService: PhotoUploadService?

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
        uploadStore: PhotoUploadStore,
        templateId: String? = nil
    ) async {
        guard case .idle = prep, !groups.isEmpty else { return }

        await runPipeline(
            groups: groups,
            uploadService: uploadService,
            uploadStore: uploadStore,
            templateId: templateId
        )
    }

    /// Reset a failed start back to `.idle` and re-run. Both `.failed` exits in
    /// `run` happen before any inventory item is created, so retrying can't
    /// duplicate work. Wired to the queue view's "Try again" (US-971).
    func retry(
        groups: [PreparedGroup],
        uploadService: PhotoUploadService,
        uploadStore: PhotoUploadStore,
        templateId: String? = nil
    ) async {
        guard case .failed = prep else { return }
        prep = .idle
        await runPipeline(
            groups: groups,
            uploadService: uploadService,
            uploadStore: uploadStore,
            templateId: templateId
        )
    }

    private func runPipeline(
        groups: [PreparedGroup],
        uploadService: PhotoUploadService,
        uploadStore: PhotoUploadStore,
        templateId: String?
    ) async {
        let userId: String
        do {
            userId = try await SupabaseShared.client.auth.session.user.id.uuidString
        } catch {
            prep = .failed("You need to be signed in to generate listings.")
            return
        }

        self.uploadService = uploadService
        self.uploadStore = uploadStore
        self.templateId = templateId

        prep = .running(done: 0, total: groups.count)

        // Phase 1 — create every item and schedule ALL its uploads immediately.
        // Each `schedule` kicks the shared service, which runs up to
        // `maxConcurrent` transfers across the whole batch; so group N's photos
        // begin uploading while we're still creating group N+1. A single group
        // that fails to create is recorded and skipped — it never stalls the
        // rest of the batch.
        var built: [PreparedItem] = []
        var createFailures = 0
        for group in groups {
            do {
                let itemId = try await createItem(userId: userId)
                let scheduled = scheduleUploads(
                    group: group, itemId: itemId, userId: userId,
                    uploadService: uploadService, uploadStore: uploadStore
                )
                built.append(PreparedItem(itemId: itemId, group: group, scheduled: scheduled))
            } catch {
                createFailures += 1
                Telemetry.breadcrumb(
                    "AutoLister item create failed, skipping group — \(message(error))",
                    category: "autolister"
                )
            }
        }

        guard !built.isEmpty else {
            prep = .failed("Couldn't create any items for this batch. Check your connection and try again.")
            return
        }
        if createFailures > 0 {
            Telemetry.event("autolister_prep_partial_create", props: [
                "created": built.count, "failed": createFailures,
            ])
        }

        prepared = built
        await finishPreparation()
    }

    /// Phase 2 — wait for the overlapped uploads, classify, then generate. On a
    /// timeout this parks in `.timedOut` instead of generating from a partial
    /// photo set. Shared by the initial run and the post-timeout retry.
    private func finishPreparation() async {
        guard let uploadStore else { return }
        let itemIds = prepared.map(\.itemId)

        let allComplete = await waitForUploads(itemIds: itemIds, uploadStore: uploadStore)
        guard allComplete else {
            let pending = itemIds.filter {
                !Self.isItemUploadComplete(uploadStore.tasks(inventoryItemId: $0))
            }.count
            Telemetry.event("autolister_upload_timeout", props: [
                "pending": pending,
                "total": itemIds.count,
                "photos_done": uploadProgress?.photosDone ?? 0,
                "photos_total": uploadProgress?.photosTotal ?? 0,
            ])
            prep = .timedOut(pending: pending, total: itemIds.count)
            return
        }

        for item in prepared {
            await applyClassification(group: item.group, scheduled: item.scheduled)
        }
        await generate()
    }

    /// Re-drives the uploads after a timeout: re-queues any failed transfers and
    /// waits again from a fresh deadline. An explicit user action — generation
    /// still only proceeds once everything is uploaded.
    func retryUploads() async {
        guard case .timedOut = prep,
              let uploadService, let uploadStore, !prepared.isEmpty else { return }
        prep = .running(done: 0, total: prepared.count)
        for item in prepared {
            for task in uploadStore.tasks(inventoryItemId: item.itemId) {
                if case .failed = task.phase { uploadService.retry(task.id) }
            }
        }
        await finishPreparation()
    }

    /// Proceeds to generation from the photos that DID upload, after the user
    /// explicitly accepts a partial set following a timeout. Distinct from the
    /// old silent fall-through: it only runs on an explicit tap.
    func generateAnyway() async {
        guard case .timedOut = prep, !prepared.isEmpty else { return }
        for item in prepared {
            await applyClassification(group: item.group, scheduled: item.scheduled)
        }
        await generate()
    }

    /// Hands the prepared item ids to the batch store for generation + photo-QA.
    private func generate() async {
        let itemIds = prepared.map(\.itemId)
        let templateId = self.templateId
        uploadProgress = nil
        prep = .finished
        await batch.submit(itemIds: itemIds, templateId: templateId)
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
            let slot = CaptureSlot(idx == 0 ? .front : .detail)
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

    /// Poll the upload store until EVERY item's scheduled uploads reach a
    /// terminal state, or the batch STALLS (US-2373: no photo has finished for
    /// `uploadStallTimeout`). Publishes photo- and item-level progress as it
    /// goes. Returns `true` if everything completed, `false` on a stall — the
    /// caller decides whether to warn (it does) rather than generate from
    /// partial work.
    private func waitForUploads(itemIds: [String], uploadStore: PhotoUploadStore) async -> Bool {
        let itemsTotal = itemIds.count
        var lastPhotosDone = -1
        var lastProgressAt = Date.now
        while true {
            var photosDone = 0
            var photosTotal = 0
            var itemsDone = 0
            for id in itemIds {
                let tasks = uploadStore.tasks(inventoryItemId: id)
                photosTotal += tasks.count
                photosDone += tasks.filter(\.isTerminal).count
                if Self.isItemUploadComplete(tasks) { itemsDone += 1 }
            }
            prep = .running(done: itemsDone, total: itemsTotal)
            uploadProgress = UploadProgress(
                photosDone: photosDone,
                photosTotal: photosTotal,
                itemsDone: itemsDone,
                itemsTotal: itemsTotal
            )
            if itemsDone == itemsTotal { return true }
            // Any photo finishing anywhere in the batch counts as progress and
            // buys the whole batch another full window.
            if photosDone > lastPhotosDone {
                lastPhotosDone = photosDone
                lastProgressAt = Date.now
            } else if Date.now.timeIntervalSince(lastProgressAt) >= Self.uploadStallTimeout {
                return false
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    /// PURE: an item's uploads are "complete" once it has at least one task and
    /// every task is terminal (uploaded or cancelled). A still-`failed` or
    /// in-flight task keeps the item pending so it counts toward a timeout.
    nonisolated static func isItemUploadComplete(_ tasks: [PhotoUploadTask]) -> Bool {
        !tasks.isEmpty && tasks.allSatisfy(\.isTerminal)
    }

    /// Best-effort cover/role classification + write-back. Any failure here is
    /// swallowed — the listing still generates from the uploaded photos.
    private func applyClassification(group: PreparedGroup, scheduled: [ScheduledPhoto]) async {
        guard !scheduled.isEmpty else { return }
        let inputs = scheduled.map { ClassifyPhotoInput(id: $0.id, storagePath: $0.storagePath) }
        let res: ClassifyPhotosResponse
        do {
            res = try await service.classifyPhotos(inputs)
        } catch {
            // US-1003: classification is best-effort, but a swallowed failure
            // means cover/role ordering silently defaulted. Leave a breadcrumb
            // so the missing write-back is diagnosable; the listing still
            // generates from the uploaded photos.
            Telemetry.breadcrumb(
                "AutoLister classify-photos failed, keeping default photo order — \(message(error))",
                category: "autolister"
            )
            return
        }

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
            do {
                _ = try await SupabaseShared.client
                    .from("item_photos")
                    .update(Patch(sort_order: p.sortOrder, photo_type: p.photoType))
                    .eq("storage_path", value: p.storagePath)
                    .execute()
            } catch {
                // US-1003: a failed role write-back leaves that photo on its
                // default role/order. Best-effort, but breadcrumb it so the
                // drift is diagnosable.
                Telemetry.breadcrumb(
                    "AutoLister photo-role write-back failed for \(p.storagePath) — \(message(error))",
                    category: "autolister"
                )
            }
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
