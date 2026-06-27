import Foundation
import UserNotifications

/// Thin wrapper around `UNUserNotificationCenter` for the local-only
/// 'N new eBay sale(s)' notification that ``BackgroundRefreshService``
/// emits after a background sync. We deliberately keep this separate
/// from push (US-187) because it's a fundamentally different mechanism:
/// scheduled locally from the BG handler, no APNs token needed.
/// Seam so ``BackgroundRefreshService`` can be unit-tested with a spy that
/// records notifications (the concrete notifier no-ops in tests because
/// UNUserNotificationCenter isn't authorized).
// Internal (not `public`): the requirement exposes the internal `LocalSale`
// SwiftData model, which a public protocol may not do. The notifier is only
// used within this app target.
@MainActor
protocol NewSaleNotifying: AnyObject {
    func notifyNewSales(count: Int, latest: LocalSale) async
}

@MainActor
public final class NewSaleNotifier: NewSaleNotifying {

    nonisolated public init() {}

    /// Requests permission for local notifications. MUST be called from a
    /// FOREGROUND context (US-1259) — `requestAuthorization` can only present
    /// its system prompt while the app is active, and a request from the BG
    /// refresh task wastes the limited BG budget on a call that can't succeed.
    /// The app already prompts at reliable foreground moments
    /// (`PushService.requestPermissionAtReliableMomentIfNeeded` after the first
    /// sync, and on the Money tab), so the notify path below only CHECKS the
    /// existing grant and never requests.
    public func requestPermissionIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
    }

    /// Schedules an immediate-delivery local notification — but only when
    /// authorization is ALREADY granted. US-1259: this runs from the BG refresh
    /// task, which must never trigger a permission request; if the grant is
    /// undetermined we simply skip (a foreground context prompts instead).
    func notifyNewSales(count: Int, latest: LocalSale) async {
        // US-1257: respect the per-category mute toggle (Settings → Push
        // notifications → "New eBay sales"). A muted category schedules nothing.
        guard NotificationPreferences.isEnabled(.saleCreated) else { return }

        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else {
            return
        }

        let content = UNMutableNotificationContent()
        content.title = count == 1 ? "New eBay sale" : "\(count) new eBay sales"
        content.body = formatBody(count: count, latest: latest)
        content.sound = .default
        // Category lets a deep-link handler downstream (US-187) route
        // the tap to the Sales tab → item detail.
        content.categoryIdentifier = "sale.created"

        let request = UNNotificationRequest(
            identifier: "new-sale.\(latest.id)",
            content: content,
            trigger: nil   // immediate
        )
        try? await center.add(request)
    }

    /// Builds a body line that's useful at a glance — the latest sale's
    /// price + a brief 'and N more' suffix when applicable.
    private func formatBody(count: Int, latest: LocalSale) -> String {
        let formatter = CurrencyFormatter()
        let price = formatter.formatDisplay(latest.salePrice)
        if count == 1 {
            return "\(price) just landed."
        }
        return "Latest at \(price), plus \(count - 1) more."
    }
}
