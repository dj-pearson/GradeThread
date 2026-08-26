import SwiftData
import XCTest
@testable import GradeThread

@MainActor
final class BackgroundRefreshTests: XCTestCase {

    private let toggleKey = "com.gradethread.app.bgRefresh.enabled"
    private let lastSaleSeenIdKey = "com.gradethread.app.bgRefresh.lastSaleSeenId"
    private let lastGradedIdsKey = "com.gradethread.app.bgRefresh.lastGradedIds"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: toggleKey)
        UserDefaults.standard.removeObject(forKey: lastSaleSeenIdKey)
        UserDefaults.standard.removeObject(forKey: lastGradedIdsKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: toggleKey)
        UserDefaults.standard.removeObject(forKey: lastSaleSeenIdKey)
        UserDefaults.standard.removeObject(forKey: lastGradedIdsKey)
        super.tearDown()
    }

    // MARK: - isEnabled (UserDefaults round-trip)

    func test_isEnabled_defaultsToTrue_whenKeyMissing() {
        // No value in UserDefaults — the AC says default ON.
        let service = BackgroundRefreshService()
        XCTAssertTrue(service.isEnabled)
    }

    func test_isEnabled_writesThroughToUserDefaults() {
        var service = BackgroundRefreshService()
        service.isEnabled = false
        XCTAssertFalse(service.isEnabled)
        XCTAssertEqual(UserDefaults.standard.bool(forKey: toggleKey), false)
    }

    func test_isEnabled_secondInstance_sees_persistedValue() {
        // Cross-instance state — important because the Settings toggle
        // and the AppDelegate handler each construct fresh
        // BackgroundRefreshService values and rely on UserDefaults to
        // share state.
        var service = BackgroundRefreshService()
        service.isEnabled = false
        let other = BackgroundRefreshService()
        XCTAssertFalse(other.isEnabled)
    }

    func test_refreshIdentifier_matchesInfoPlist() {
        // BGTaskScheduler will refuse to register/submit an identifier
        // that isn't in BGTaskSchedulerPermittedIdentifiers. This test
        // pins the value so any rename here forces an Info.plist update
        // alongside.
        XCTAssertEqual(
            BackgroundRefreshService.refreshIdentifier,
            "com.gradethread.app.refresh"
        )
    }

    // MARK: - performRefresh (US-984: await the real sync, no fixed sleep)

    /// The core behavioral guarantee: a sale that lands server-side during the
    /// pull fires its notification within the SAME background run. Because the
    /// fake engine only merges the sale when `sync()` is awaited, this would
    /// fail if detection ran before (or concurrently with) the pull.
    func test_performRefresh_firesSaleNotification_afterPullMergeCommits() async throws {
        let container = try makeContainer()
        let saleNotifier = SpyNewSaleNotifier()
        let gradeNotifier = SpyNewGradeNotifier()
        let service = BackgroundRefreshService(
            modelContainer: container,
            notifier: saleNotifier,
            gradeNotifier: gradeNotifier
        )

        // Non-nil baseline so detection isn't in its silent first-run mode.
        UserDefaults.standard.set("baseline-sale", forKey: lastSaleSeenIdKey)

        // The engine merges the server sale into the local store as part of
        // sync() — i.e. exactly when the real pull would commit it.
        let engine = FakeSyncEngine {
            await MainActor.run {
                let ctx = ModelContext(container)
                ctx.insert(LocalSale(
                    id: "srv-1",
                    inventoryItemId: "item-1",
                    salePrice: 42,
                    saleDate: .now
                ))
                try? ctx.save()
            }
            return .ok
        }
        service.attachSyncEngine(engine)

        let success = await service.performRefresh()

        XCTAssertTrue(success)
        XCTAssertEqual(
            saleNotifier.notifiedCounts, [1],
            "A sale merged during the pull should fire exactly one notification in the same run"
        )
    }

    /// No engine and no container (e.g. signed out / not yet booted) must report
    /// failure rather than claim a no-op run succeeded.
    func test_performRefresh_reportsFailure_whenNoEngineAvailable() async {
        let service = BackgroundRefreshService()
        let success = await service.performRefresh()
        XCTAssertFalse(success)
    }

    /// A failed pull must surface as a failed run so iOS doesn't mark success
    /// off stale data.
    func test_performRefresh_reportsFailure_whenSyncFails() async throws {
        let container = try makeContainer()
        let service = BackgroundRefreshService(
            modelContainer: container,
            notifier: SpyNewSaleNotifier(),
            gradeNotifier: SpyNewGradeNotifier()
        )
        let engine = FakeSyncEngine { .failed("network down") }
        service.attachSyncEngine(engine)

        let success = await service.performRefresh()
        XCTAssertFalse(success)
    }

    /// US-1159: when iOS expires the task (the expiration handler cancels the
    /// work), performRefresh must bail before touching the cache and report
    /// failure — never fire notifications off a half-merged snapshot nor claim
    /// success.
    func test_performRefresh_cancelled_bailsAndReportsFailure() async throws {
        let container = try makeContainer()
        let saleNotifier = SpyNewSaleNotifier()
        let gradeNotifier = SpyNewGradeNotifier()
        let service = BackgroundRefreshService(
            modelContainer: container,
            notifier: saleNotifier,
            gradeNotifier: gradeNotifier
        )
        service.attachSyncEngine(FakeSyncEngine { .ok })

        // Mirror what the BGTask expirationHandler does: cancel the work task.
        let task = Task { await service.performRefresh() }
        task.cancel()
        let success = await task.value

        XCTAssertFalse(success, "An expired/cancelled refresh must report failure")
        XCTAssertTrue(
            saleNotifier.notifiedCounts.isEmpty && gradeNotifier.notifiedCounts.isEmpty,
            "Detection must be skipped once the task is cancelled"
        )
    }

    // MARK: - runForegroundDetection (US-1259: foreground-arrived rows alert too)

    /// A sale merged by a FOREGROUND sync must raise the alert via
    /// `runForegroundDetection` — without it, only the BG task ever noticed
    /// foreground arrivals (and its silent first-run seed could swallow them).
    func test_runForegroundDetection_firesSaleNotification_forForegroundArrival() async throws {
        let container = try makeContainer()
        let saleNotifier = SpyNewSaleNotifier()
        let gradeNotifier = SpyNewGradeNotifier()
        let service = BackgroundRefreshService(
            modelContainer: container,
            notifier: saleNotifier,
            gradeNotifier: gradeNotifier
        )

        // Non-nil baseline so detection isn't in its silent first-run mode.
        UserDefaults.standard.set("baseline-sale", forKey: lastSaleSeenIdKey)

        // Simulate a foreground sync committing a new sale to the local store.
        await MainActor.run {
            let ctx = ModelContext(container)
            ctx.insert(LocalSale(
                id: "fg-1",
                inventoryItemId: "item-1",
                salePrice: 19,
                saleDate: .now
            ))
            try? ctx.save()
        }

        await service.runForegroundDetection()

        XCTAssertEqual(
            saleNotifier.notifiedCounts, [1],
            "A sale merged by a foreground sync should fire exactly one notification"
        )
    }

    /// No container attached (e.g. signed out / not yet booted) is a safe no-op
    /// — never crash, never notify.
    func test_runForegroundDetection_noContainer_isNoOp() async {
        let saleNotifier = SpyNewSaleNotifier()
        let gradeNotifier = SpyNewGradeNotifier()
        let service = BackgroundRefreshService(
            notifier: saleNotifier,
            gradeNotifier: gradeNotifier
        )
        await service.runForegroundDetection()
        XCTAssertTrue(saleNotifier.notifiedCounts.isEmpty)
        XCTAssertTrue(gradeNotifier.notifiedCounts.isEmpty)
    }

    // MARK: - Helpers

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalSource.self,
            LocalSourcer.self,
            LocalPendingMutation.self,
        ])
        let config = ModelConfiguration(
            schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none
        )
        return try ModelContainer(for: schema, configurations: config)
    }
}

// MARK: - Test doubles

@MainActor
private final class SpyNewSaleNotifier: NewSaleNotifying {
    private(set) var notifiedCounts: [Int] = []
    func notifyNewSales(count: Int, latest: LocalSale) async {
        notifiedCounts.append(count)
    }
}

@MainActor
private final class SpyNewGradeNotifier: NewGradeNotifying {
    private(set) var notifiedCounts: [Int] = []
    func notifyNewGrades(count: Int, latest: LocalInventoryItem) async {
        notifiedCounts.append(count)
    }
}

/// Stand-in SyncEngine that runs an injected closure when `sync()` is awaited,
/// letting a test merge server rows at exactly the moment the real pull would.
private final class FakeSyncEngine: BackgroundSyncing, @unchecked Sendable {
    private let onSync: @Sendable () async -> SyncEngine.SyncOutcome
    init(_ onSync: @escaping @Sendable () async -> SyncEngine.SyncOutcome) {
        self.onSync = onSync
    }
    func sync() async -> SyncEngine.SyncOutcome { await onSync() }
}
