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

public extension NotificationActionID {
    /// The `userInfo` keys ``NotificationActionPlan/from(actionIdentifier:userInfo:userText:)``
    /// needs before it can build anything but a fallback deep link (US-3274).
    var requiredPayloadKeys: Set<String> {
        switch self {
        case .acceptOffer, .counterOffer: return ["best_offer_id", "inventory_item_id"]
        case .markShipped: return ["sale_id"]
        // OAuth needs nothing from the payload; the app foregrounds and the
        // connection card takes over.
        case .reconnectEbay: return []
        }
    }
}

public extension NotificationCategoryID {
    /// The `userInfo` keys the edge actually stamps on this category's pushes.
    ///
    /// ⚠ THIS IS A MIRROR OF `contracts/push-contract.json`, WHICH IS
    /// GENERATED FROM `transactional-push.ts` AND IS AUTHORITATIVE. The app
    /// target cannot read a repo file at runtime, so the values are written
    /// here and CHECKED against the artefact by
    /// `NotificationActionAvailabilityTests` (US-3279). A case added here that
    /// the edge does not send re-enables a dead button, which is the exact
    /// defect US-3274 found and US-3275 fixed; the artefact is what stops the
    /// mirror drifting again.
    ///
    /// Every transactional sender ships `kind` (the growth campaign does not).
    /// The rest are per category.
    var payloadKeys: Set<String> {
        switch self {
        case .offerReceived:
            // best_offer_id is the offer Accept and Counter act on;
            // inventory_item_id is the item a plain tap lands on.
            return ["kind", "best_offer_id", "inventory_item_id"]
        case .saleCreated:
            // sale_id is what Mark shipped closes. There is no separate
            // shipping push, so this notification IS the shipping prompt.
            return ["kind", "sale_id", "inventory_item_id"]
        case .delistNeeded:
            return ["kind", "inventory_item_id"]
        case .offerResponded:
            // The verb, not an id: "accepted" / "declined" / "countered".
            return ["kind", "action"]
        // US-3279: the post-order family has carried the case's external id
        // since US-3275 and iOS did not know. No action needs it today, so
        // nothing changes on screen -- but a mirror that under-reports is the
        // same class of defect as one that over-reports, and the artefact is
        // now what decides.
        case .returnOpened, .inquiryOpened, .caseOpened, .caseDeadline,
             .cancellationRequested, .disputeOpened:
            return ["kind", "case_id"]
        // The growth campaign is sent by routes/admin-growth.ts, not
        // transactional-push.ts, and carries no `kind` stamp: only the
        // campaign id and the link it opens. It declares no inline action, so
        // this changes nothing on screen; it keeps the mirror honest.
        case .marketing:
            return ["campaign_id", "url"]
        default:
            return ["kind"]
        }
    }

    /// The inline buttons US-1133 declares for this category, before the
    /// payload check below.
    var declaredActions: [NotificationActionID] {
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

    /// Inline action buttons actually registered for this category (US-1133).
    ///
    /// ⚠ THIS USED TO BE `declaredActions`, AND ITS COMMENT SAID "no dead
    /// button is ever shown". The test it applied was whether the CATEGORY's
    /// send was live, not whether the payload carried the ids the ACTION needs,
    /// and those are different questions. Five of the six buttons in the app
    /// failed the second one.
    ///
    /// What a seller saw: an offer notification with Accept on it, a Face ID
    /// prompt (accept and counter are `.authenticationRequired` because they
    /// move money), and then the app opening on the inbox with nothing
    /// accepted. They authenticated for nothing. Same for Mark shipped on a
    /// sale push. `NotificationActionPlan` handles the missing ids correctly —
    /// it falls back to a deep link rather than firing a broken edge call — so
    /// nothing was ever wrong except the button being there at all.
    ///
    /// Only `reconnectEbay` needs nothing from the payload, which is why it is
    /// the one that always worked.
    var actions: [NotificationActionID] {
        declaredActions.filter { $0.requiredPayloadKeys.isSubset(of: payloadKeys) }
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
                let typed = (trimmed?.isEmpty == false) ? trimmed : nil
                // US-3272: anything typed has to LOOK like a tracking number.
                //
                // This path had the trim and not the shape check that
                // `MarkShippedSheet` has carried since US-1178, and it is the
                // riskier of the two: text from the lock screen, no sheet, no
                // warning, no confirmation. `FulfillmentService` pushes a
                // non-empty tracking straight to eBay's shipping_fulfillment,
                // which cannot be edited afterwards, and the buyer gets a
                // tracking link that goes nowhere.
                //
                // Falling back to the screen is the same answer `counterOffer`
                // above already gives an unparseable price: open the place
                // where it can be done properly rather than send something
                // wrong. Marking it shipped WITHOUT the number would be worse —
                // it buries the mistake under a state the seller cannot see is
                // incomplete.
                if let typed, !TrackingNumber.isPlausible(typed) {
                    return .deepLink(.salesTab(inventoryItemId: itemId))
                }
                return .markShipped(saleId: saleId, tracking: typed)
            }
            return .deepLink(.salesTab(inventoryItemId: itemId))

        case .reconnectEbay:
            return .reconnect
        }
    }

    /// Parses a user-typed counter price tolerant of currency symbols / commas
    /// ("$42.50" → 42.5). Returns nil when nothing numeric was typed.
    /// US-1491: routes through the locale-aware CurrencyFormatter so "42,50" in a
    /// comma-decimal locale reads 42.5, not 4250 (a filter-to-digits+dot strip
    /// dropped the comma and pushed a 100× counter to the live eBay offer).
    static func parsePrice(_ text: String?) -> Double? {
        guard let text else { return nil }
        return CurrencyFormatter().parse(text)
    }
}
