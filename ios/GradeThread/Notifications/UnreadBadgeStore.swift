import Foundation
import Observation
import UserNotifications

/// US-2557: the unread-notification count behind the tab badge and the app-icon
/// badge.
///
/// Modelled on ``ReconcileBadgeStore`` deliberately — same shell-level shape,
/// same injected fetch so the paths are testable without a network, same
/// best-effort refresh. Where they differ is stated below, because each
/// difference is a decision rather than an omission.
///
/// ⚠ IT READS THE EDGE, NOT THE TABLE. The story suggested querying
/// `public.notifications` directly, which is what web does. The count has to be
/// a head+exact query though, and getting that wrong is not a compile error — it
/// is a number that silently stops rising at the page size, which is exactly the
/// bug the web bell shipped with. `GET /api/notifications/unread-count` reuses
/// the same counter that badges a push payload, so the number on the icon and
/// the number in a push cannot disagree.
///
/// ⚠ A FAILED REFRESH KEEPS THE LAST COUNT. A network blip is not "you have no
/// unread mail", and the route answers 503 rather than 0 precisely so this can
/// hold the distinction. The only things that lower this number are a successful
/// refresh and ``reset()``.
@MainActor
@Observable
public final class UnreadBadgeStore {
    /// Unread notifications for the active user. 0 hides the badge.
    public private(set) var unreadCount: Int = 0

    /// Injected so tests can drive success / failure / preserve-last-value
    /// without the network; defaults to the edge route.
    private let fetchCount: () async throws -> Int
    /// Injected so the app-icon write is observable in a test and does not need
    /// a real UNUserNotificationCenter.
    private let setIconBadge: (Int) async -> Void
    /// Re-entrancy guard so overlapping foreground refreshes do not stack.
    private var isRefreshing = false

    public init(
        fetchCount: @escaping () async throws -> Int = {
            struct Response: Decodable { let unread: Int }
            let response: Response = try await EdgeAPI.shared.getJSON("/api/notifications/unread-count")
            return response.unread
        },
        setIconBadge: @escaping (Int) async -> Void = { count in
            // iOS 16+ replacement for applicationIconBadgeNumber. Failures are
            // swallowed: a refused badge must never surface as an error to a
            // seller who did not ask for one.
            try? await UNUserNotificationCenter.current().setBadgeCount(max(0, count))
        }
    ) {
        self.fetchCount = fetchCount
        self.setIconBadge = setIconBadge
    }

    /// Whether the tab badge should render at all.
    public var hasUnread: Bool { unreadCount > 0 }

    /// Refreshes the count. No-op while one is already in flight; on failure the
    /// previous count is preserved and the icon is left exactly as it was.
    public func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let next = try await fetchCount()
            unreadCount = max(0, next)
            await setIconBadge(unreadCount)
        } catch {
            // Keep the last known value. The icon is NOT touched here: writing 0
            // on a failed read would clear a badge showing five unread because
            // the network hiccupped, which is the whole reason the route answers
            // 503 instead of 0.
        }
    }

    /// Clears the count and the app icon — sign-out, or the user marking
    /// everything read. The server only ever RAISES the badge (a push cannot
    /// know a notification was read on another device), so clearing is the app's
    /// job on the same signal that marks rows read.
    public func reset() async {
        unreadCount = 0
        await setIconBadge(0)
    }
}
