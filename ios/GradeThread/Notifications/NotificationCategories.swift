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
