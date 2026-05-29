import Foundation
import UserNotifications

/// Thin wrapper around `UNUserNotificationCenter` for the local-only
/// 'N new eBay sale(s)' notification that ``BackgroundRefreshService``
/// emits after a background sync. We deliberately keep this separate
/// from push (US-187) because it's a fundamentally different mechanism:
/// scheduled locally from the BG handler, no APNs token needed.
@MainActor
public final class NewSaleNotifier {

    nonisolated public init() {}

    /// Requests permission for local notifications. The caller can
    /// fire-and-forget; the notification system silently no-ops when
    /// permission is denied, so we don't gate the BG sync itself on
    /// the grant.
    public func requestPermissionIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
    }

    /// Schedules an immediate-delivery local notification. iOS will
    /// suppress it if permission isn't granted — no error to surface.
    func notifyNewSales(count: Int, latest: LocalSale) async {
        await requestPermissionIfNeeded()

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
