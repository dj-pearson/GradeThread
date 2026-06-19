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

    /// Fetches the orphan count for a user id. Injected so tests can drive the
    /// success / failure / preserve-last-value paths without Supabase; the
    /// default routes to the real ``ReconciliationService``.
    private let fetchCount: (String) async throws -> Int
    /// Re-entrancy guard so overlapping foreground/scene refreshes don't stack.
    private var isRefreshing = false

    public init(
        fetchCount: @escaping (String) async throws -> Int = { userId in
            try await ReconciliationService().countOrphans(userId: userId)
        }
    ) {
        self.fetchCount = fetchCount
    }

    /// Whether the affordance should show.
    public var hasOrphans: Bool { orphanCount > 0 }

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
    /// previous user's banner before their own refresh lands.
    public func reset() {
        orphanCount = 0
    }
}
