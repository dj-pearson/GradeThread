import Foundation
import UserNotifications

/// Identifiers for the inline notification action buttons (US-1133). Like the
/// category strings these are a wire contract — each value is matched against
/// `response.actionIdentifier` in ``NotificationDelegate``, so renaming one
/// silently breaks the button on every already-installed app.
public enum NotificationActionID: String, CaseIterable {
    /// Accept a buyer's best offer outright.
    case acceptOffer = "offer.accept"
    /// Counter a buyer's best offer — carries the typed counter price.
    case counterOffer = "offer.counter"
    /// Mark a sold order shipped — carries the optionally-typed tracking number.
    case markShipped = "order.mark_shipped"
    /// Reopen the eBay OAuth flow when the token is expiring.
    case reconnectEbay = "ebay.reconnect"

    /// User-facing button title.
    public var title: String {
        switch self {
        case .acceptOffer:   return "Accept"
        case .counterOffer:  return "Counter"
        case .markShipped:   return "Mark shipped"
        case .reconnectEbay: return "Reconnect"
        }
    }

    /// Counter + Mark-shipped take a free-text value typed inline on the
    /// notification (counter price / tracking number); the other two are plain
    /// taps. Returns nil for a plain `UNNotificationAction`.
    public var textInput: (placeholder: String, button: String)? {
        switch self {
        case .counterOffer: return ("Your counter price", "Send")
        case .markShipped:  return ("Tracking number (optional)", "Mark shipped")
        default:            return nil
        }
    }

    public var options: UNNotificationActionOptions {
        switch self {
        // OAuth needs the app foregrounded to present the web auth session.
        case .reconnectEbay: return [.foreground]
        // Accept / counter move money — require the device be unlocked first.
        case .acceptOffer, .counterOffer: return [.authenticationRequired]
        case .markShipped: return []
        }
    }

    /// Builds the concrete system action (plain or inline-text).
    public func makeAction() -> UNNotificationAction {
        if let input = textInput {
            return UNTextInputNotificationAction(
                identifier: rawValue,
                title: title,
                options: options,
                textInputButtonTitle: input.button,
                textInputPlaceholder: input.placeholder
            )
        }
        return UNNotificationAction(identifier: rawValue, title: title, options: options)
    }
}

public extension NotificationCategoryID {
    /// Inline action buttons for this category (US-1133). Only categories whose
    /// backend APNs send is LIVE get actions; categories whose send isn't wired
    /// yet (grade.ready, message.received, listing.ended, aging.digest,
    /// payout.posted) intentionally return `[]` so no dead button is ever shown
    /// — AC: "actions are no-ops/hidden where the backend send isn't live yet".
    var actions: [NotificationActionID] {
        switch self {
        case .offerReceived:
            return [.acceptOffer, .counterOffer]
        case .saleCreated:
            // "You made a sale 🎉" is the de-facto shipping prompt — there is no
            // separate shipping push, so the mark-shipped action lives here.
            return [.markShipped]
        case .tokenExpiring:
            return [.reconnectEbay]
        default:
            return []
        }
    }
}

/// The resolved intent of an inline action tap — PURE (no I/O) so it's unit
/// testable exactly like ``DeepLinkRoute/from(category:userInfo:)``.
/// ``NotificationDelegate`` maps each case to an edge call or a deep link.
public enum NotificationActionPlan: Equatable {
    case acceptOffer(bestOfferId: String, itemId: String)
    case counterOffer(bestOfferId: String, itemId: String, price: Double)
    case markShipped(saleId: String, tracking: String?)
    /// OAuth must run interactively — foreground the app onto Marketplaces where
    /// the reconnect button lives.
    case reconnect
    /// The action's required ids weren't in the payload (the backend send isn't
    /// stamping them yet): fall back to opening the relevant screen instead of
    /// firing a broken edge call.
    case deepLink(DeepLinkRoute)
    /// Not an action we recognise.
    case none

    public static func from(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any],
        userText: String?
    ) -> NotificationActionPlan {
        guard let action = NotificationActionID(rawValue: actionIdentifier) else {
            return .none
        }
        let itemId = userInfo["inventory_item_id"] as? String
        let bestOfferId = userInfo["best_offer_id"] as? String
        let saleId = userInfo["sale_id"] as? String

        switch action {
        case .acceptOffer:
            if let bestOfferId, let itemId {
                return .acceptOffer(bestOfferId: bestOfferId, itemId: itemId)
            }
            return .deepLink(.negotiationInbox(filterItemId: itemId))

        case .counterOffer:
            if let bestOfferId, let itemId,
               let price = Self.parsePrice(userText), price > 0 {
                return .counterOffer(bestOfferId: bestOfferId, itemId: itemId, price: price)
            }
            return .deepLink(.negotiationInbox(filterItemId: itemId))

        case .markShipped:
            if let saleId {
                let trimmed = userText?.trimmingCharacters(in: .whitespacesAndNewlines)
                let tracking = (trimmed?.isEmpty == false) ? trimmed : nil
                return .markShipped(saleId: saleId, tracking: tracking)
            }
            return .deepLink(.salesTab(inventoryItemId: itemId))

        case .reconnectEbay:
            return .reconnect
        }
    }

    /// Parses a user-typed counter price tolerant of currency symbols / commas
    /// ("$42.50" → 42.5). Returns nil when nothing numeric was typed.
    static func parsePrice(_ text: String?) -> Double? {
        guard let text else { return nil }
        let cleaned = text.filter { $0.isNumber || $0 == "." }
        guard !cleaned.isEmpty else { return nil }
        return Double(cleaned)
    }
}
