import SwiftData
import XCTest
@testable import GradeThread

@MainActor
final class PhotoUploadTests: XCTestCase {

    // MARK: - PhotoUploadTask

    func test_task_phaseTransitions_areExclusive() {
        var task = makeTask()
        XCTAssertEqual(task.phase, .queued)
        XCTAssertEqual(task.progress, 0)
        XCTAssertFalse(task.isActive)
        XCTAssertFalse(task.isTerminal)

        task.phase = .uploading(progress: 0.25)
        XCTAssertEqual(task.progress, 0.25)
        XCTAssertTrue(task.isActive)
        XCTAssertFalse(task.isTerminal)

        task.phase = .uploaded(publicURL: "https://example.test/foo.jpg")
        XCTAssertEqual(task.progress, 1.0)
        XCTAssertFalse(task.isActive)
        XCTAssertTrue(task.isTerminal)

        task.phase = .failed(error: "nope")
        XCTAssertFalse(task.isActive)
        XCTAssertFalse(task.isTerminal)

        task.phase = .cancelled
        XCTAssertFalse(task.isActive)
        XCTAssertTrue(task.isTerminal)
    }

    // MARK: - PhotoUploadStore

    func test_store_upsertAndLookup_bySlotAndItem() {
        let store = PhotoUploadStore()
        let front = makeTask(slot: .front, itemId: "item-A")
        let back = makeTask(slot: .back, itemId: "item-A")
        let frontOther = makeTask(slot: .front, itemId: "item-B")

        store.upsert(front)
        store.upsert(back)
        store.upsert(frontOther)

        XCTAssertEqual(store.task(for: .front, inventoryItemId: "item-A")?.id, front.id)
        XCTAssertEqual(store.task(for: .back, inventoryItemId: "item-A")?.id, back.id)
        XCTAssertEqual(store.task(for: .front, inventoryItemId: "item-B")?.id, frontOther.id)
        XCTAssertNil(store.task(for: .tag, inventoryItemId: "item-A"))

        XCTAssertEqual(store.tasks(inventoryItemId: "item-A").count, 2)
        XCTAssertEqual(store.pendingTasks(inventoryItemId: "item-A").count, 2)
    }

    func test_store_pendingTasks_excludesUploadedAndCancelled() {
        let store = PhotoUploadStore()
        let queued = makeTask(slot: .front, itemId: "item-A")
        var uploaded = makeTask(slot: .back, itemId: "item-A")
        uploaded.phase = .uploaded(publicURL: "https://example.test/x.jpg")
        var cancelled = makeTask(slot: .tag, itemId: "item-A")
        cancelled.phase = .cancelled
        var failed = makeTask(slot: .detail, itemId: "item-A")
        failed.phase = .failed(error: "boom")

        for task in [queued, uploaded, cancelled, failed] { store.upsert(task) }

        let pending = store.pendingTasks(inventoryItemId: "item-A")
        XCTAssertEqual(pending.count, 2)
        XCTAssertTrue(pending.contains { $0.slot == .front })
        XCTAssertTrue(pending.contains { $0.slot == .detail })
    }

    func test_store_activeCount_countsOnlyUploadingTasks() {
        let store = PhotoUploadStore()
        var a = makeTask(slot: .front, itemId: "item-A")
        a.phase = .uploading(progress: 0.5)
        var b = makeTask(slot: .back, itemId: "item-A")
        b.phase = .uploading(progress: 0.1)
        let c = makeTask(slot: .tag, itemId: "item-A") // queued

        store.upsert(a)
        store.upsert(b)
        store.upsert(c)

        XCTAssertEqual(store.activeCount(), 2)
    }

    func test_store_updatePhase_reflectsLatestState() {
        let store = PhotoUploadStore()
        let task = makeTask()
        store.upsert(task)
        store.updatePhase(task.id, to: .uploading(progress: 0.5))

        let updated = store.tasks[task.id]
        if case let .uploading(progress) = updated?.phase {
            XCTAssertEqual(progress, 0.5)
        } else {
            XCTFail("expected uploading phase")
        }
    }

    func test_store_bumpRetry_increments() {
        let store = PhotoUploadStore()
        let task = makeTask()
        store.upsert(task)
        XCTAssertEqual(store.tasks[task.id]?.retryCount, 0)
        store.bumpRetry(task.id)
        store.bumpRetry(task.id)
        XCTAssertEqual(store.tasks[task.id]?.retryCount, 2)
    }

    func test_store_reset_clearsAllTasks() {
        let store = PhotoUploadStore()
        store.upsert(makeTask())
        store.upsert(makeTask())
        XCTAssertEqual(store.tasks.count, 2)
        store.reset()
        XCTAssertTrue(store.tasks.isEmpty)
    }

    // MARK: - Concurrency cap (smoke-tested via the store directly)

    /// We don't unit-test the URLSession plumbing — that requires a real
    /// background session which CI can't exercise hermetically. But the
    /// scheduling math is self-contained: at most `maxConcurrent` tasks
    /// can be in the `.uploading` phase at a time. Verify the store
    /// surface that powers the cap rather than driving the real service.
    func test_concurrencyCap_storeMath() {
        let store = PhotoUploadStore()
        let cap = PhotoUploadService.maxConcurrent
        XCTAssertEqual(cap, 3, "Cap is documented at 3 — change tests if this changes")

        // Simulate three active uploads. activeCount must reflect them.
        for slot in [PhotoSlotType.front, .back, .tag] {
            var t = makeTask(slot: slot, itemId: "item-A")
            t.phase = .uploading(progress: 0.1)
            store.upsert(t)
        }
        XCTAssertEqual(store.activeCount(), cap)

        // A new queued task does NOT auto-promote to uploading from the
        // store's perspective — the service is responsible for promoting
        // it when an active slot finishes. activeCount stays at the cap.
        store.upsert(makeTask(slot: .detail, itemId: "item-A"))
        XCTAssertEqual(store.activeCount(), cap)
    }

    // MARK: - cancelAll deterministic reset (US-1018)

    /// `cancelAll` must tear the store/id-maps down off the cancellation
    /// completion, NOT after a fixed `Task.sleep`. We drive that completion
    /// manually: until it fires the store still holds the (now-cancelled)
    /// tasks; once it fires every trace is gone. A sign-out → sign-in can
    /// therefore never surface a previous user's residual upload progress.
    func test_cancelAll_resetsStoreDeterministicallyAfterCancellation() {
        let store = PhotoUploadStore()
        var seeded = makeTask(slot: .front, itemId: "item-A")
        seeded.phase = .uploading(progress: 0.4)
        store.upsert(seeded)

        let service = PhotoUploadService(
            store: store,
            sessionIdentifier: "test-cancel-\(UUID().uuidString)"
        )

        // Capture the completion instead of running it, so we control exactly
        // when the post-cancellation reset happens.
        var capturedCompletion: (@MainActor () -> Void)?
        service.cancelInFlightTasks = { completion in
            capturedCompletion = completion
        }

        service.cancelAll()

        // Cancellation hasn't reported back yet: the task is marked cancelled
        // but still present — the reset is explicitly NOT on a timer.
        XCTAssertEqual(store.tasks.count, 1)
        XCTAssertEqual(store.tasks[seeded.id]?.phase, .cancelled)
        XCTAssertNotNil(capturedCompletion, "cancelAll must route its reset through the cancellation completion")

        // Session confirms cancellation → deterministic teardown.
        capturedCompletion?()

        XCTAssertTrue(store.tasks.isEmpty, "no residual upload progress should survive cancellation")
        XCTAssertTrue(service.sessionTaskIdToUploadId.isEmpty)
        XCTAssertTrue(service.sortOrderByUploadId.isEmpty)
    }

    // MARK: - DB-link failure auto-retries (US-1001)

    /// A storage upload that succeeds but whose `item_photos` insert fails
    /// (e.g. the access token expired between the two phases) must NOT rely on
    /// the manual retry button — that's lost the moment the user leaves the
    /// capture screen. It enqueues a pending mutation so the next SyncEngine
    /// pass re-links the photo automatically.
    func test_dbLinkFailure_enqueuesPendingMutation_forAutoRetry() throws {
        let store = PhotoUploadStore()
        let container = try makeContainer()
        let service = PhotoUploadService(
            store: store,
            modelContainer: container,
            sessionIdentifier: "test-linkfail-\(UUID().uuidString)"
        )

        let task = makeTask(slot: .front, itemId: "item-A")
        store.upsert(task)

        service.handlePhotoLinkFailure(task: task, message: "token expired")

        // Surfaced as failed for the UI...
        if case let .failed(error) = store.tasks[task.id]?.phase {
            XCTAssertTrue(error.contains("token expired"))
        } else {
            XCTFail("expected failed phase")
        }

        // ...AND a pending mutation was queued so the next sync re-links it
        // without re-prompting the user.
        let context = ModelContext(container)
        let mutations = try context.fetch(FetchDescriptor<LocalPendingMutation>())
        XCTAssertEqual(mutations.count, 1)
        let mutation = try XCTUnwrap(mutations.first)
        XCTAssertEqual(mutation.kindEnum, .uploadPhoto)
        XCTAssertEqual(mutation.targetId, "item-A")

        // The payload carries the deterministic row id (the task's own id) so
        // the replay upserts the SAME item_photos row — no duplicate.
        struct Payload: Decodable {
            let photo_id: String
            let storage_path: String
            let local_file_url: String
        }
        let payload = try JSONDecoder().decode(Payload.self, from: mutation.payload)
        XCTAssertEqual(payload.photo_id, PhotoUploadService.photoId(for: task))
        XCTAssertEqual(payload.storage_path, task.storagePath)
        XCTAssertEqual(payload.local_file_url, task.localFileURL.path)
    }

    // MARK: - Storage upload auth-failure re-queue (US-1252)

    /// A storage upload rejected with 401/403 (an expired/invalid signed-upload
    /// token or per-user-folder RLS) must NOT dead-end as a terminal `.failed`:
    /// it routes through the network-failure path so the task is marked failed
    /// for the UI AND a pending mutation is queued, letting the next SyncEngine
    /// pass re-mint a fresh signed URL and re-upload from disk.
    func test_storageUpload_401_requeuesForReupload() throws {
        try assertUploadStatusRequeues(code: 401)
    }

    func test_storageUpload_403_requeuesForReupload() throws {
        try assertUploadStatusRequeues(code: 403)
    }

    /// A transient storage 5xx is also recoverable on a re-upload.
    func test_storageUpload_503_requeuesForReupload() throws {
        try assertUploadStatusRequeues(code: 503)
    }

    private func assertUploadStatusRequeues(code: Int) throws {
        let store = PhotoUploadStore()
        let container = try makeContainer()
        let service = PhotoUploadService(
            store: store,
            modelContainer: container,
            sessionIdentifier: "test-upload\(code)-\(UUID().uuidString)"
        )
        let task = makeTask(slot: .front, itemId: "item-A")
        store.upsert(task)

        service.handleFailedUploadStatus(task, code: code)

        // Surfaced as failed for the UI...
        if case let .failed(error) = store.tasks[task.id]?.phase {
            XCTAssertTrue(error.contains("\(code)"))
        } else {
            XCTFail("expected failed phase for HTTP \(code)")
        }
        // ...AND a pending mutation was queued so the next sync re-mints + re-uploads.
        let context = ModelContext(container)
        let mutations = try context.fetch(FetchDescriptor<LocalPendingMutation>())
        XCTAssertEqual(mutations.count, 1, "HTTP \(code) should queue a re-upload")
        XCTAssertEqual(mutations.first?.kindEnum, .uploadPhoto)
        XCTAssertEqual(mutations.first?.targetId, "item-A")
    }

    /// A deterministic client error (e.g. 400) stays terminal — re-minting won't
    /// help — so it does NOT queue a re-upload mutation.
    func test_storageUpload_400_isTerminal_noRequeue() throws {
        let store = PhotoUploadStore()
        let container = try makeContainer()
        let service = PhotoUploadService(
            store: store,
            modelContainer: container,
            sessionIdentifier: "test-upload400-\(UUID().uuidString)"
        )
        let task = makeTask(slot: .front, itemId: "item-A")
        store.upsert(task)

        service.handleFailedUploadStatus(task, code: 400)

        if case .failed = store.tasks[task.id]?.phase {} else {
            XCTFail("expected failed phase")
        }
        let context = ModelContext(container)
        let mutations = try context.fetch(FetchDescriptor<LocalPendingMutation>())
        XCTAssertTrue(mutations.isEmpty, "deterministic client errors should not queue a re-upload")
    }

    func test_isRecoverableUploadStatus_classification() {
        XCTAssertTrue(PhotoUploadService.isRecoverableUploadStatus(401))
        XCTAssertTrue(PhotoUploadService.isRecoverableUploadStatus(403))
        XCTAssertTrue(PhotoUploadService.isRecoverableUploadStatus(500))
        XCTAssertTrue(PhotoUploadService.isRecoverableUploadStatus(503))
        XCTAssertFalse(PhotoUploadService.isRecoverableUploadStatus(400))
        XCTAssertFalse(PhotoUploadService.isRecoverableUploadStatus(404))
        XCTAssertFalse(PhotoUploadService.isRecoverableUploadStatus(409))
        XCTAssertFalse(PhotoUploadService.isRecoverableUploadStatus(200))
    }

    // MARK: - Helpers

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalSource.self,
            LocalPendingMutation.self,
        ])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        return try ModelContainer(for: schema, configurations: config)
    }

    private func makeTask(
        slot: PhotoSlotType = .front,
        itemId: String = "item-A"
    ) -> PhotoUploadTask {
        PhotoUploadTask(
            inventoryItemId: itemId,
            userId: "user-1",
            slot: slot,
            storagePath: "user-1/\(itemId)/\(slot.serverPhotoType)_0.jpg",
            localFileURL: URL(fileURLWithPath: "/tmp/nope-\(UUID()).jpg"),
            bytes: 1024
        )
    }
}
