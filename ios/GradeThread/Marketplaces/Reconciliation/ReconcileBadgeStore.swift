import Foundation
import Observation

/// Shell-level, tab-independent orphan-listing affordance (US-749). The
/// Reconciliation surface used to live only inside the Marketplaces tab and
/// only appear when the eBay sync left unmatched listings. This store hoists
/// the *count* up to ``MainShell`` so the user gets a "you have N unmatched
/// listings — reconcile" banner no matter which tab they're on.
///
/// Deliberately count-only + best-effort: a failed refresh keeps the last known
/// count rather than flickering the banner away (a transient network error is
/// not "all reconciled"). The full orphan list still loads lazily inside
/// ``ReconciliationView`` when the user taps through.
@MainActor
@Observable
public final class ReconcileBadgeStore {
    /// Number of unmatched eBay listings for the active user. 0 hides the banner.
    public private(set) var orphanCount: Int = 0

    /// US-1262: when set + still in the future, the user snoozed the banner, so it
    /// stays hidden unless new orphan work pushes the count above the baseline it
    /// was snoozed at. Persisted so the dismissal survives launches.
    public private(set) var snoozedUntil: Date?
    /// Orphan count at the moment of the snooze; a count above this re-surfaces
    /// the banner even within the snooze window (genuinely new work to reconcile).
    private var snoozeBaseline: Int = 0

    /// Fetches the orphan count for a user id. Injected so tests can drive the
    /// success / failure / preserve-last-value paths without Supabase; the
    /// default routes to the real ``ReconciliationService``.
    private let fetchCount: (String) async throws -> Int
    /// Re-entrancy guard so overlapping foreground/scene refreshes don't stack.
    private var isRefreshing = false
    private let defaults: UserDefaults
    /// Injected clock so the snooze-window logic is unit-testable without waiting.
    private let now: () -> Date

    /// US-1262: how long a manual snooze hides the banner before it re-appears.
    public static let snoozeWindow: TimeInterval = 60 * 60 * 24  // 24 hours
    private static let snoozeUntilKey = "com.gradethread.app.reconcile.snoozeUntil.v1"
    private static let snoozeBaselineKey = "com.gradethread.app.reconcile.snoozeBaseline.v1"

    public init(
        fetchCount: @escaping (String) async throws -> Int = { userId in
            try await ReconciliationService().countOrphans(userId: userId)
        },
        defaults: UserDefaults = .standard,
        now: @escaping () -> Date = { Date() }
    ) {
        self.fetchCount = fetchCount
        self.defaults = defaults
        self.now = now
        let stored = defaults.double(forKey: Self.snoozeUntilKey)
        self.snoozedUntil = stored > 0 ? Date(timeIntervalSince1970: stored) : nil
        self.snoozeBaseline = defaults.integer(forKey: Self.snoozeBaselineKey)
    }

    /// US-1262: whether the banner is currently snoozed — within the window AND no
    /// new orphan work has appeared since the snooze.
    public var isSnoozed: Bool {
        guard let until = snoozedUntil, now() < until else { return false }
        return orphanCount <= snoozeBaseline
    }

    /// Whether the affordance should show: there's work AND it isn't snoozed.
    public var hasOrphans: Bool { orphanCount > 0 && !isSnoozed }

    /// US-1262: hide the banner for ``snoozeWindow``. It re-appears once the
    /// window elapses or if more unmatched listings show up than there were when
    /// it was snoozed, so the reminder is dismissible without being lost forever.
    public func snooze() {
        let until = now().addingTimeInterval(Self.snoozeWindow)
        snoozedUntil = until
        snoozeBaseline = orphanCount
        defaults.set(until.timeIntervalSince1970, forKey: Self.snoozeUntilKey)
        defaults.set(orphanCount, forKey: Self.snoozeBaselineKey)
    }

    /// Refreshes the count for the given user. No-op while a refresh is already
    /// in flight; on failure the previous count is preserved.
    public func refresh(userId: String) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            orphanCount = try await fetchCount(userId)
        } catch {
            // Keep the last known value — a network blip isn't "all reconciled".
        }
    }

    /// Clears the count (e.g. on sign-out) so the next user never inherits the
    /// previous user's banner before their own refresh lands. US-1262: also clears
    /// the snooze so the next user isn't silently muted by this one's dismissal.
    public func reset() {
        orphanCount = 0
        snoozedUntil = nil
        snoozeBaseline = 0
        defaults.removeObject(forKey: Self.snoozeUntilKey)
        defaults.removeObject(forKey: Self.snoozeBaselineKey)
    }
}
