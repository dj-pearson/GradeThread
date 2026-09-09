import XCTest
@testable import GradeThread

/// US-3242: `tasks(inventoryItemId:)` sorted the WHOLE store before filtering,
/// and the store is only emptied on sign-out — so its cost grew with everything
/// the seller had uploaded since launch, on a call the capture screen makes once
/// per slot per progress tick.
@MainActor
final class PhotoUploadStoreScalingTests: XCTestCase {

    private func task(item: String, slot: CaptureSlot, createdAt: Date) -> PhotoUploadTask {
        PhotoUploadTask(
            inventoryItemId: item,
            userId: "u1",
            slot: slot,
            storagePath: "u1/\(item)/\(UUID().uuidString).jpg",
            localFileURL: URL(fileURLWithPath: "/tmp/\(UUID().uuidString).jpg"),
            bytes: 1024,
            createdAt: createdAt
        )
    }

    /// The behavior has to be identical: this item's tasks, oldest first.
    func test_tasksForItem_returnsOnlyThatItemOldestFirst() {
        let store = PhotoUploadStore()
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let slots = PhotoSlotType.allCases.map(CaptureSlot.init)

        store.upsert(task(item: "b", slot: slots[0], createdAt: base))
        store.upsert(task(item: "a", slot: slots[0], createdAt: base.addingTimeInterval(30)))
        store.upsert(task(item: "a", slot: slots[1 % slots.count], createdAt: base.addingTimeInterval(10)))
        store.upsert(task(item: "c", slot: slots[0], createdAt: base.addingTimeInterval(5)))

        let forA = store.tasks(inventoryItemId: "a")
        XCTAssertEqual(forA.count, 2)
        XCTAssertTrue(forA.allSatisfy { $0.inventoryItemId == "a" })
        XCTAssertEqual(forA.map(\.createdAt), forA.map(\.createdAt).sorted())
        XCTAssertEqual(forA.first?.createdAt, base.addingTimeInterval(10))
    }

    func test_tasksForItem_isEmptyForAnItemWithNoUploads() {
        let store = PhotoUploadStore()
        store.upsert(task(item: "a", slot: CaptureSlot(.front), createdAt: .now))
        XCTAssertTrue(store.tasks(inventoryItemId: "zzz").isEmpty)
    }

    /// The point of the change: one item's answer must not get slower because
    /// other items were uploaded earlier in the session. A thousand unrelated
    /// tasks used to be a thousand-element sort on every one of these calls.
    func test_tasksForItem_answerIsUnaffectedByUnrelatedVolume() {
        let store = PhotoUploadStore()
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let slots = PhotoSlotType.allCases.map(CaptureSlot.init)

        for i in 0..<1_000 {
            store.upsert(
                task(item: "other-\(i)", slot: slots[i % slots.count], createdAt: base.addingTimeInterval(Double(i)))
            )
        }
        store.upsert(task(item: "mine", slot: slots[0], createdAt: base.addingTimeInterval(9_000)))
        store.upsert(task(item: "mine", slot: slots[1 % slots.count], createdAt: base.addingTimeInterval(8_000)))

        let mine = store.tasks(inventoryItemId: "mine")
        XCTAssertEqual(mine.count, 2)
        XCTAssertEqual(mine.first?.createdAt, base.addingTimeInterval(8_000))
        XCTAssertEqual(store.pendingTasks(inventoryItemId: "mine").count, 2)
    }
}
