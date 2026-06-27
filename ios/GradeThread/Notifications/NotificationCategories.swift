import Foundation
import UserNotifications

/// Notification category identifiers shared between the server (which
/// stamps `categoryIdentifier` on each payload) and the iOS receive
/// side. Adding a new category here is a forward-compatible change as
/// long as the server keeps sending matching strings.
public enum NotificationCategoryID: String, CaseIterable {
    case saleCreated      = "sale.created"
    case payoutCleared    = "payout.cleared"
    case tokenExpiring    = "token.expiring"
    case itemReviewNeeded = "item.review_needed"
    case gradeReady       = "grade.ready"
    // US-679: expanded reseller alert categories. The backend stamps these
    // `categoryIdentifier`s once the corresponding APNs sends ship (noted as a
    // dependency); the receive side + Settings toggles + tap routing are ready.
    case offerReceived    = "offer.received"
    case messageReceived  = "message.received"
    case listingEnded     = "listing.ended"
    case agingDigest      = "aging.digest"
    case payoutPosted     = "payout.posted"
    // US-1136: a support agent replied to one of the user's tickets. The receive
    // side + tap routing (into the native ticket thread) are ready; the backend
    // APNs send ships separately (same forward-compatible pattern as US-679).
    case supportReply     = "support.reply"

    /// User-facing label for the Settings UI toggle.
    public var label: String {
        switch self {
        case .saleCreated:      return "New eBay sales"
        case .payoutCleared:    return "Payouts cleared"
        case .tokenExpiring:    return "eBay token expiring"
        case .itemReviewNeeded: return "Items need review"
        case .gradeReady:       return "Certified grades ready"
        case .offerReceived:    return "Best offers received"
        case .messageReceived:  return "Buyer messages"
        case .listingEnded:     return "Listing ended / relist"
        case .agingDigest:      return "Aging stock digest"
        case .payoutPosted:     return "Payouts posted"
        case .supportReply:     return "Support replies"
        }
    }

    public var helpText: String {
        switch self {
        case .saleCreated:      return "Pushes when eBay reports a sold listing."
        case .payoutCleared:    return "Pushes when funds reach your bank."
        case .tokenExpiring:    return "Critical reminder when the eBay token expires in <7 days. Reconnect to keep syncing."
        case .itemReviewNeeded: return "Pushes when an AI grading result lands below the confidence threshold."
        case .gradeReady:       return "Lets you know when an item's certified condition grade finishes."
        case .offerReceived:    return "Pushes when a buyer sends a best offer you can accept, decline or counter."
        case .messageReceived:  return "Pushes when a buyer sends you a message."
        case .listingEnded:     return "Pushes when a listing ends unsold so you can relist it."
        case .agingDigest:      return "A periodic summary of stock that's been sitting too long."
        case .payoutPosted:     return "Pushes when eBay posts a payout (before it clears your bank)."
        case .supportReply:     return "Pushes when our support team replies to one of your tickets."
        }
    }

    /// The token-expiring category opts in to time-sensitive interruption
    /// (bypass DND) per the AC. The other categories use default delivery.
    public var options: UNNotificationCategoryOptions {
        switch self {
        case .tokenExpiring: return [.customDismissAction]
        default:             return []
        }
    }
}

/// US-1257: per-category mute preferences, set by the Settings toggles
/// (`NotificationCategoryToggle`) and now actually consulted on the receive
/// side. Single source of truth for the UserDefaults key + the default-ON
/// read, so the toggle, the foreground-presentation delegate, and the local
/// notifiers (`NewSaleNotifier`/`NewGradeNotifier`) all agree.
public enum NotificationPreferences {
    /// Per-category UserDefaults key. Kept stable — it persists across launches.
    public static func userDefaultsKey(for category: NotificationCategoryID) -> String {
        "com.gradethread.app.notifyPref.\(category.rawValue)"
    }

    /// Whether the user wants notifications for this category. An absent key
    /// means enabled (default ON), matching the toggle's initial state.
    public static func isEnabled(
        _ category: NotificationCategoryID,
        defaults: UserDefaults = .standard
    ) -> Bool {
        defaults.object(forKey: userDefaultsKey(for: category)) as? Bool ?? true
    }

    /// Resolves a raw push `categoryIdentifier` to its preference. An unknown
    /// category defaults ON so a newly-added server category is never silently
    /// suppressed before the app ships its matching toggle.
    public static func isEnabled(
        rawCategory: String,
        defaults: UserDefaults = .standard
    ) -> Bool {
        guard let category = NotificationCategoryID(rawValue: rawCategory) else { return true }
        return isEnabled(category, defaults: defaults)
    }
}

/// Registers every UNNotificationCategory at process launch so the
/// system associates incoming pushes with the right tap-handling rules.
@MainActor
public enum NotificationCategories {

    public static func registerAll() async {
        let center = UNUserNotificationCenter.current()
        let categories = NotificationCategoryID.allCases.map { id in
            // US-1133: attach the inline action buttons each category declares.
            // Categories whose backend send isn't live yet declare no actions,
            // so they register with an empty button set (unchanged behavior).
            UNNotificationCategory(
                identifier: id.rawValue,
                actions: id.actions.map { $0.makeAction() },
                intentIdentifiers: [],
                options: id.options
            )
        }
        center.setNotificationCategories(Set(categories))
    }
}
