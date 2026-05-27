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

    // MARK: - Helpers

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
