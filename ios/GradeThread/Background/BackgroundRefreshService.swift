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
    private let notifier: any NewSaleNotifying
    private let gradeNotifier: any NewGradeNotifying

    // US-984: weak handle to the live ``SyncEngine`` so the BG task can await
    // the real pull+merge directly instead of posting a notification then
    // sleeping a fixed interval. Weak because the engine's lifecycle is owned
    // by ContentView (created on sign-in, dropped on sign-out); a stale handle
    // simply triggers the cold-launch fallback in `resolveSyncEngine`.
    private weak var syncEngine: (any BackgroundSyncing)?

    // Internal (not `public`): the `notifier`/`gradeNotifier` parameters are the
    // internal `NewSaleNotifying`/`NewGradeNotifying` protocols (they expose
    // internal SwiftData models), and a `public init` may not expose an internal
    // type. The service is only constructed within this app target.
    init(
        modelContainer: ModelContainer? = nil,
        notifier: any NewSaleNotifying = NewSaleNotifier(),
        gradeNotifier: any NewGradeNotifying = NewGradeNotifier()
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

    /// Injects the live ``SyncEngine`` once ContentView builds it (on sign-in).
    /// Held weakly — see `syncEngine`. Idempotent; called again whenever a new
    /// engine is created (e.g. after a workspace switch re-builds it).
    func attachSyncEngine(_ engine: any BackgroundSyncing) {
        syncEngine = engine
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
            // US-1148: breadcrumb it so a misconfigured permitted-identifier (a
            // release-build issue invisible to the DEBUG print) is diagnosable.
            Telemetry.backgroundBreadcrumb(
                "Background refresh schedule submit failed: \(error.localizedDescription)",
                category: "background")
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
            await self.performRefresh()
        }

        // US-1412: enforce the self-imposed `budgetSeconds` — previously only the
        // OS `expirationHandler` could cancel, so a non-cooperative `engine.sync()`
        // could overrun toward the ~30s OS limit and get us throttled out of
        // future slots. This watchdog cancels the work first; `performRefresh`
        // observes `Task.isCancelled` and bails, and `setTaskCompleted` reports
        // the honest (unfinished) outcome.
        let watchdog = Task {
            try? await Task.sleep(nanoseconds: UInt64(Self.budgetSeconds * 1_000_000_000))
            work.cancel()
        }

        task.expirationHandler = { [work] in
            // iOS is about to kill us — cancel the work so we don't get
            // throttled out of future schedules. `performRefresh` observes
            // the cancellation and skips detection, and `setTaskCompleted`
            // below reports the real (unfinished) outcome.
            // US-1148: telemeter the expiration so a pattern of the OS killing
            // refreshes early (budget too tight) is visible, not invisible.
            Telemetry.backgroundBreadcrumb(
                "Background refresh expired before completion", category: "background")
            work.cancel()
        }

        let success = await work.value
        watchdog.cancel()
        task.setTaskCompleted(success: success)
    }

    /// One background-refresh pass, decoupled from `BGAppRefreshTask` so it's
    /// directly unit-testable. Awaits the real pull+merge via the SyncEngine
    /// (no fixed sleep), then runs new-sale / new-grade detection — which
    /// therefore only ever sees rows the pull has already committed. Returns
    /// whether the run genuinely succeeded so `setTaskCompleted` is honest.
    func performRefresh() async -> Bool {
        guard let engine = resolveSyncEngine() else {
            // No container/engine available (e.g. signed out) — we can't pull,
            // so report failure rather than claim a no-op succeeded.
            return false
        }

        let outcome = await engine.sync()

        // If iOS expired the task while the pull was in flight, bail before
        // touching the cache so we don't fire notifications off a half-merged
        // snapshot — and so the completion below reports failure.
        if Task.isCancelled { return false }

        // Detection runs ONLY after sync() returns, i.e. after the pull merge
        // has committed to the SwiftData store.
        await detectNewSalesAndNotify()
        await detectNewGradesAndNotify()

        if case .failed = outcome { return false }
        return true
    }

    /// US-1259: run new-sale / new-grade detection after a FOREGROUND sync.
    /// The foreground ``SyncEngine`` (and Realtime) merge rows while the app is
    /// active; without this, those arrivals were noticed ONLY by the BG task —
    /// and on a fresh session the BG task's silent first-run seed would SWALLOW
    /// them (folded into the baseline with no alert). Running detection here
    /// seeds the baseline at sign-in and raises the alert for rows that land
    /// while the app is open, while advancing the shared baselines so the BG
    /// path can't later re-notify the same rows. Safe to call on every
    /// foreground sync: the notifiers fire only when notification permission is
    /// already granted (requested from a foreground context), and detection is
    /// idempotent against the persisted baselines.
    func runForegroundDetection() async {
        guard modelContainer != nil else { return }
        await detectNewSalesAndNotify()
        await detectNewGradesAndNotify()
    }

    /// Resolves the SyncEngine to drive this pass. Prefers the live engine
    /// ContentView injected; on a cold launch (the app was woken directly into
    /// the background, so the SwiftUI scene never built one) it constructs a
    /// throwaway engine bound to the same container. A single `sync()` needs
    /// neither a started connectivity loop nor a UI-visible status store, so
    /// the throwaway is safe to discard after the run. Returns nil only when no
    /// container has been attached yet.
    private func resolveSyncEngine() -> (any BackgroundSyncing)? {
        if let syncEngine { return syncEngine }
        guard let modelContainer else { return nil }
        return SyncEngine(
            container: modelContainer,
            statusStore: SyncStatusStore(),
            networkMonitor: NetworkMonitor()
        )
    }

    /// US-1259: clears the new-sale / new-grade detection baselines so the next
    /// detection pass re-seeds silently. MUST be called whenever the local cache
    /// is wiped + re-scoped to a DIFFERENT row set — sign-out and workspace
    /// switch — because the baselines are global (not workspace-scoped); without
    /// this the next detection would see the new scope's back-catalog as "new"
    /// and fire spurious alerts. Mirrors `SyncWatermark().resetAll()`.
    public func resetDetectionBaselines() {
        UserDefaults.standard.removeObject(forKey: Self.lastSaleSeenIdKey)
        UserDefaults.standard.removeObject(forKey: Self.lastGradedIdsKey)
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

// MARK: - SyncEngine seam (US-984)

/// The slice of ``SyncEngine`` the background-refresh task depends on. Extracted
/// to a protocol so the BG handler can hold a weak handle and so tests can
/// inject a fake engine that drives the pull→detection ordering deterministically.
protocol BackgroundSyncing: AnyObject, Sendable {
    @discardableResult
    func sync() async -> SyncEngine.SyncOutcome
}

extension SyncEngine: BackgroundSyncing {}
