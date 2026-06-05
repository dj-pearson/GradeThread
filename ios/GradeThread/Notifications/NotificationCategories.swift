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

    /// User-facing label for the Settings UI toggle.
    public var label: String {
        switch self {
        case .saleCreated:      return "New eBay sales"
        case .payoutCleared:    return "Payouts cleared"
        case .tokenExpiring:    return "eBay token expiring"
        case .itemReviewNeeded: return "Items need review"
        case .gradeReady:       return "Certified grades ready"
        }
    }

    public var helpText: String {
        switch self {
        case .saleCreated:      return "Pushes when eBay reports a sold listing."
        case .payoutCleared:    return "Pushes when funds reach your bank."
        case .tokenExpiring:    return "Critical reminder when the eBay token expires in <7 days. Reconnect to keep syncing."
        case .itemReviewNeeded: return "Pushes when an AI grading result lands below the confidence threshold."
        case .gradeReady:       return "Lets you know when an item's certified condition grade finishes."
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

/// Registers every UNNotificationCategory at process launch so the
/// system associates incoming pushes with the right tap-handling rules.
@MainActor
public enum NotificationCategories {

    public static func registerAll() async {
        let center = UNUserNotificationCenter.current()
        let categories = NotificationCategoryID.allCases.map { id in
            UNNotificationCategory(
                identifier: id.rawValue,
                actions: [],
                intentIdentifiers: [],
                options: id.options
            )
        }
        center.setNotificationCategories(Set(categories))
    }
}
