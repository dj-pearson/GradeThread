import Foundation
import UserNotifications

/// Local-only "your certified grade is ready" notification, fired by
/// ``BackgroundRefreshService`` after a background sync detects a freshly
/// graded inventory item. Deliberately separate from push (US-187): it's
/// scheduled locally from the BG handler, no APNs token needed — the same
/// mechanism as ``NewSaleNotifier``.
/// Seam so ``BackgroundRefreshService`` can be unit-tested with a spy that
/// records notifications (mirrors ``NewSaleNotifying``).
// Internal (not `public`): the requirement exposes the internal
// `LocalInventoryItem` SwiftData model, which a public protocol may not do. The
// notifier is only used within this app target.
@MainActor
protocol NewGradeNotifying: AnyObject {
    func notifyNewGrades(count: Int, latest: LocalInventoryItem) async
}

@MainActor
public final class NewGradeNotifier: NewGradeNotifying {

    nonisolated public init() {}

    /// Requests local-notification permission. MUST be called from a FOREGROUND
    /// context (US-1259) — `requestAuthorization` can only present its prompt
    /// while the app is active, and requesting from the BG refresh task wastes
    /// the BG budget on a call that can't succeed. Foreground prompts already
    /// happen (`PushService.requestPermissionAtReliableMomentIfNeeded`, Money
    /// tab); the notify path below only CHECKS the existing grant.
    public func requestPermissionIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
    }

    /// Schedules an immediate local notification for one or more newly graded
    /// items — but only when authorization is ALREADY granted. US-1259: this
    /// runs from the BG refresh task and must never trigger a permission
    /// request; an undetermined grant simply skips (foreground prompts instead).
    func notifyNewGrades(count: Int, latest: LocalInventoryItem) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else {
            return
        }

        let content = UNMutableNotificationContent()
        content.title = count == 1 ? "Certified grade ready" : "\(count) certified grades ready"
        content.body = formatBody(count: count, latest: latest)
        content.sound = .default
        // Category drives the tap deep-link (→ the Certified grades list).
        content.categoryIdentifier = NotificationCategoryID.gradeReady.rawValue
        content.userInfo = ["inventory_item_id": latest.id]

        let request = UNNotificationRequest(
            identifier: "new-grade.\(latest.id)",
            content: content,
            trigger: nil   // immediate
        )
        try? await center.add(request)
    }

    /// Glanceable body: the latest item's title + its grade, plus an
    /// "and N more" suffix when several landed at once.
    private func formatBody(count: Int, latest: LocalInventoryItem) -> String {
        let title = latest.title.isEmpty ? "An item" : latest.title
        let grade = latest.gradeValue.map { String(format: "%.1f", $0) }
        let gradePhrase = grade.map { "graded \($0)" } ?? "is graded"
        if count == 1 {
            return "\(title) \(gradePhrase)."
        }
        return "\(title) \(gradePhrase), plus \(count - 1) more."
    }
}

/// Pure set-diff for newly-graded detection — extracted so it's unit-testable
/// without a ModelContainer or UserDefaults.
public enum GradeNotificationDiff {
    /// Ids that are graded now but weren't last time we checked. On the very
    /// first run (`lastSeen == nil`) returns empty so we don't bombard the
    /// user with a notification for every already-graded item.
    public static func newlyGraded(
        current: Set<String>,
        lastSeen: Set<String>?
    ) -> Set<String> {
        guard let lastSeen else { return [] }
        return current.subtracting(lastSeen)
    }
}
