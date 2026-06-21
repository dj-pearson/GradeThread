import XCTest
import SwiftData
@testable import GradeThread

/// US-1142: the offline cache no longer swallows save failures. `saveOrLog`
/// persists on the happy path and reports failures through `PersistenceHealth`
/// (scrubbed breadcrumb + a notification the shell throttles into a notice)
/// instead of the old silent `try? save()`.
@MainActor
final class ModelContextSaveTests: XCTestCase {

    func test_saveOrLog_persistsChanges_andReturnsTrue() throws {
        let container = try inMemoryContainer()
        let context = ModelContext(container)
        context.insert(LocalPendingMutation(kind: .createInventoryItem, payload: Data(), targetId: "abc"))

        XCTAssertTrue(context.saveOrLog("test_persist"))

        let rows = try ModelContext(container)
            .fetch(FetchDescriptor<LocalPendingMutation>())
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.targetId, "abc")
    }

    func test_saveOrLog_noChanges_isTrueAndQuiet() throws {
        let container = try inMemoryContainer()
        let context = ModelContext(container)

        // No pending changes → genuine no-op, no failure notification.
        let notified = expectation(
            forNotification: PersistenceHealth.saveFailedNotification, object: nil)
        notified.isInverted = true

        XCTAssertTrue(context.saveOrLog("test_noop"))
        wait(for: [notified], timeout: 0.2)
    }

    func test_recordSaveFailure_postsNotificationWithOperation() {
        let notified = expectation(
            forNotification: PersistenceHealth.saveFailedNotification,
            object: nil
        ) { note in
            (note.userInfo?["operation"] as? String) == "test_op"
        }

        struct Boom: Error {}
        PersistenceHealth.recordSaveFailure(operation: "test_op", error: Boom())

        wait(for: [notified], timeout: 1.0)
    }

    private func inMemoryContainer() throws -> ModelContainer {
        let config = ModelConfiguration(
            schema: ModelStoreProvider.schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(for: ModelStoreProvider.schema, configurations: config)
    }
}
