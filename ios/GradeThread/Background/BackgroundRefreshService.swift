import BackgroundTasks
import Foundation
import SwiftData
import UIKit

/// Owns the BGAppRefreshTask lifecycle. Two responsibilities:
///   1. Register the task identifier at app launch so iOS knows to call
///      us when the system schedules a background refresh.
///   2. Schedule the next refresh when the app backgrounds and after
///      each successful run so the queue stays primed.
///
/// The actual work is `SyncEngine.sync()` — same pull-from-Supabase flow
/// the foreground hook runs. We add a 25s budget guard because BG tasks
/// must complete within 30s or iOS kills the app + may throttle future
/// schedules.
@MainActor
public final class BackgroundRefreshService {

    /// Must match the value declared under
    /// `BGTaskSchedulerPermittedIdentifiers` in Info.plist.
    public static let refreshIdentifier = "com.gradethread.app.refresh"

    private static let userDefaultsToggleKey = "com.gradethread.app.bgRefresh.enabled"
    private static let lastSaleSeenIdKey = "com.gradethread.app.bgRefresh.lastSaleSeenId"
    /// Persisted set of inventory_item ids that already carry a grade — the
    /// baseline for "newly graded" detection.
    private static let lastGradedIdsKey = "com.gradethread.app.bgRefresh.lastGradedIds"
    /// Hard budget so the task setTaskCompleted before iOS kills it.
    private static let budgetSeconds: TimeInterval = 25
    /// Minimum gap between scheduled runs. iOS treats this as a hint —
    /// real cadence is up to system heuristics.
    private static let earliestRefreshSeconds: TimeInterval = 30 * 60

    // `var` (not `let`) so the App scene can inject the SwiftData container
    // after it's constructed — the service itself is created at AppDelegate
    // init, before the container exists. See `attachModelContainer`.
    private var modelContainer: ModelContainer?
    private let notifier: NewSaleNotifier
    private let gradeNotifier: NewGradeNotifier

    public init(
        modelContainer: ModelContainer? = nil,
        notifier: NewSaleNotifier = NewSaleNotifier(),
        gradeNotifier: NewGradeNotifier = NewGradeNotifier()
    ) {
        self.modelContainer = modelContainer
        self.notifier = notifier
        self.gradeNotifier = gradeNotifier
    }

    // MARK: - User-controlled toggle

    /// Default ON; respects the user-facing 'Refresh in background'
    /// toggle (US-188 AC). We don't override iOS-level Background App
    /// Refresh — when that's OFF, BGTaskScheduler.submit simply fails
    /// silently and the task never runs.
    public var isEnabled: Bool {
        get {
            // UserDefaults returns false for missing keys; flip the
            // semantic so defaulting-on works.
            UserDefaults.standard.object(forKey: Self.userDefaultsToggleKey)
                .flatMap { ($0 as? Bool) } ?? true
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.userDefaultsToggleKey)
            if newValue {
                scheduleNext()
            } else {
                BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshIdentifier)
            }
        }
    }

    /// Injects the SwiftData container once the App scene has built it. The
    /// service is constructed at AppDelegate init (before the container
    /// exists), so the new-sale / new-grade detection that reads the local
    /// cache stays dormant until this is called. Idempotent.
    public func attachModelContainer(_ container: ModelContainer) {
        modelContainer = container
    }

    // MARK: - Registration

    /// Called from the AppDelegate's `didFinishLaunchingWithOptions`.
    /// Registration must happen synchronously at launch — iOS rejects
    /// late registration with a console warning.
    public func register() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.refreshIdentifier,
            using: nil
        ) { [weak self] task in
            guard let task = task as? BGAppRefreshTask else { return }
            Task { @MainActor [weak self] in
                await self?.handle(task: task)
            }
        }
    }

    /// Schedule the next opportunistic refresh. Called on app background
    /// and after each successful BG run so the queue stays primed.
    public func scheduleNext() {
        guard isEnabled else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: Self.earliestRefreshSeconds)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Most common cause: iOS-level Background App Refresh is
            // disabled, or BGTaskSchedulerPermittedIdentifiers in
            // Info.plist doesn't match. The latter is a build error so
            // we surface the message to console for debug builds.
            #if DEBUG
            print("[BGRefresh] submit failed: \(error.localizedDescription)")
            #endif
        }
    }

    // MARK: - Task handler

    private func handle(task: BGAppRefreshTask) async {
        // Re-queue before the work runs so we never miss a slot even
        // if the work itself crashes.
        scheduleNext()

        let work = Task { @MainActor in
            // The SyncEngine handle isn't directly accessible from the
            // app delegate (it lives in ContentView). Bridge through
            // the existing .inventoryPullRequested notification — ContentView
            // routes it to SyncEngine.sync(). The work happens during
            // the budget window even if we can't await directly.
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)

            // Give the engine a beat to start, then check for new sales
            // against the persisted baseline. We can't await the engine
            // from here, so we sleep briefly and then snapshot.
            try? await Task.sleep(nanoseconds: 8 * 1_000_000_000)
            await self.detectNewSalesAndNotify()
            await self.detectNewGradesAndNotify()
        }

        task.expirationHandler = { [work] in
            // iOS is about to kill us — abandon work cleanly so we
            // don't get throttled out of future schedules.
            work.cancel()
        }

        _ = await work.value
        task.setTaskCompleted(success: true)
    }

    // MARK: - New-sale detection

    /// Snapshots the most recent local sale id; if it's different from
    /// the last seen id (or if a sale exists for the first time), fires
    /// the local notification.
    func detectNewSalesAndNotify() async {
        guard let container = modelContainer else { return }
        let lastSeen = UserDefaults.standard.string(forKey: Self.lastSaleSeenIdKey)

        let recentSales: [LocalSale] = await MainActor.run {
            let context = ModelContext(container)
            let descriptor = FetchDescriptor<LocalSale>(
                sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
            )
            return (try? context.fetch(descriptor)) ?? []
        }
        guard let mostRecent = recentSales.first else { return }
        guard mostRecent.id != lastSeen else { return }

        // Count rows that came in since lastSeen so the notification
        // body is honest. If lastSeen was nil (first-ever run) we
        // suppress the notification — we don't want to bombard a new
        // user with "12 new sales" from the initial sync.
        if lastSeen == nil {
            UserDefaults.standard.set(mostRecent.id, forKey: Self.lastSaleSeenIdKey)
            return
        }
        let newCount = recentSales.prefix(while: { $0.id != lastSeen }).count
        UserDefaults.standard.set(mostRecent.id, forKey: Self.lastSaleSeenIdKey)

        if newCount > 0 {
            Telemetry.event(TelemetryEvent.saleRecorded, props: [
                "count": newCount,
                "source": "background_refresh",
            ])
            await notifier.notifyNewSales(count: newCount, latest: mostRecent)
        }
    }

    // MARK: - New-grade detection

    /// Diffs the set of graded inventory_item ids against the persisted
    /// baseline. Any id newly carrying a grade fires the "grade ready"
    /// notification. First-ever run seeds the baseline silently (mirrors the
    /// new-sale suppression) so a fresh install doesn't ping for back-catalog
    /// grades.
    func detectNewGradesAndNotify() async {
        guard let container = modelContainer else { return }
        let lastSeenArray = UserDefaults.standard.array(forKey: Self.lastGradedIdsKey) as? [String]
        let lastSeen: Set<String>? = lastSeenArray.map { Set($0) }

        // Graded items, most-recently-updated first (for the body line).
        let gradedItems: [LocalInventoryItem] = await MainActor.run {
            let context = ModelContext(container)
            let descriptor = FetchDescriptor<LocalInventoryItem>(
                sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
            )
            let all = (try? context.fetch(descriptor)) ?? []
            return all.filter { $0.gradeValue != nil }
        }
        let currentIds = Set(gradedItems.map(\.id))

        // Persist the current set regardless of outcome so the first run
        // seeds the baseline (and never notifies).
        UserDefaults.standard.set(Array(currentIds), forKey: Self.lastGradedIdsKey)

        let newlyGraded = GradeNotificationDiff.newlyGraded(current: currentIds, lastSeen: lastSeen)
        guard !newlyGraded.isEmpty,
              let latest = gradedItems.first(where: { newlyGraded.contains($0.id) }) else {
            return
        }

        Telemetry.event("grade.notification", props: [
            "count": newlyGraded.count,
            "source": "background_refresh",
        ])
        await gradeNotifier.notifyNewGrades(count: newlyGraded.count, latest: latest)
    }
}
