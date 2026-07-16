import Foundation
import Observation

/// Drives the eBay best-offers + buyer-messages surface (US-673).
@MainActor
@Observable
final class NegotiationStore {
    enum Phase: Equatable { case loading, ready, failed(String) }

    private let service: NegotiationProviding

    var offersPhase: Phase = .loading
    var messagesPhase: Phase = .loading
    private(set) var offers: [BestOffer] = []
    private(set) var messages: [BuyerMessage] = []
    var actionError: String?
    var actionBanner: String?

    /// US-1510: what an eligible-listings probe learned. `.unavailable` means the
    /// server said send-offer can't work on this connection (missing negotiation
    /// scope, 501 feature_unavailable) — categorically different from a transient
    /// `.failed`, which may succeed on retry.
    enum EligibleCheck: Equatable {
        case count(Int)
        /// US-1421: carries the server's own copy — the reconnect_required
        /// variant tells the seller the FIX (reconnect) instead of an
        /// indefinite "not available yet".
        case unavailable(detail: String?)
        case failed
    }

    /// US-1510: sticky once the server reports feature_unavailable, so the
    /// send-offer toolbar entry can hide on subsequent visits instead of walking
    /// the user into a dead end again. Reset only on a successful probe (the
    /// feature reactivates automatically when the scope lands — US-1421).
    /// US-1967: `loadCapability()` now sets this on APPEAR, so the entry point
    /// never renders in the unavailable case — previously it took a failed
    /// send/eligible round trip to learn, meaning the button was always live
    /// (and always doomed) on the first visit after launch.
    private(set) var sendOfferUnavailable = false

    /// US-1967: the server's reason + copy for the disabled state, so the view
    /// can explain honestly instead of guessing (and never says "reconnect"
    /// when reconnecting can't help).
    private(set) var sendOfferUnavailableDetail: String?
    private(set) var sendOfferNeedsReconnect = false

    /// US-1967: should the send-offer entry point render at all? Hidden only
    /// when the feature is UNFIXABLE (the deployment lacks the sell.negotiation
    /// licence) — a dead button with no remedy. When a reconnect would genuinely
    /// enable it, the entry stays so the sheet can say so; that's the one case
    /// where a "reconnect" prompt is honest rather than misleading.
    var showSendOfferEntry: Bool { !sendOfferUnavailable || sendOfferNeedsReconnect }

    /// US-1967: probe the capability before rendering any send-offer entry
    /// point. A probe FAILURE leaves the feature enabled — a transient network
    /// blip shouldn't hide a working feature; the send path still gates on its
    /// own 501.
    func loadCapability() async {
        do {
            let cap = try await service.capability()
            applyCapability(cap)
        } catch EdgeAPIError.featureUnavailable(let detail) {
            // Older edge builds have no /capabilities route but still gate the
            // send path — honor that answer too.
            markUnavailable(detail: detail, needsReconnect: false)
        } catch {
            // Unknown — leave as-is rather than hiding a usable feature.
        }
    }

    private func applyCapability(_ cap: NegotiationCapability) {
        guard !cap.sendOfferAvailable else {
            sendOfferUnavailable = false
            sendOfferUnavailableDetail = nil
            sendOfferNeedsReconnect = false
            return
        }
        markUnavailable(detail: cap.detail, needsReconnect: cap.needsReconnect)
    }

    private func markUnavailable(detail: String?, needsReconnect: Bool) {
        sendOfferUnavailable = true
        sendOfferUnavailableDetail = detail
        sendOfferNeedsReconnect = needsReconnect
    }

    init(service: NegotiationProviding = NegotiationService()) {
        self.service = service
    }

    func loadOffers() async {
        offersPhase = .loading
        do {
            offers = try await service.offers()
            offersPhase = .ready
        } catch {
            offersPhase = .failed(error.localizedDescription)
        }
    }

    func loadMessages() async {
        messagesPhase = .loading
        do {
            messages = try await service.messages()
            messagesPhase = .ready
        } catch {
            messagesPhase = .failed(error.localizedDescription)
        }
    }

    // US-1168: return success so the counter/offer sheets can keep themselves
    // open with an error on failure and dismiss only on success. @discardableResult
    // so the US-1160 confirmation call sites can still ignore the result.
    @discardableResult
    func accept(_ offer: BestOffer) async -> Bool { await respond(offer, action: "Accept") }
    @discardableResult
    func decline(_ offer: BestOffer) async -> Bool { await respond(offer, action: "Decline") }

    @discardableResult
    func counter(_ offer: BestOffer, price: Double, message: String?) async -> Bool {
        await respond(offer, action: "Counter", counterPrice: price, message: message)
    }

    @discardableResult
    private func respond(
        _ offer: BestOffer, action: String, counterPrice: Double? = nil, message: String? = nil
    ) async -> Bool {
        do {
            try await service.respond(
                bestOfferId: offer.bestOfferId, itemId: offer.itemId,
                action: action, counterPrice: counterPrice, message: message
            )
            // US-1238: Accept/Decline are terminal — drop the offer optimistically.
            // A Counter leaves the negotiation OPEN (the buyer can still accept or
            // counter back), so DON'T remove it or the seller loses track of the
            // open thread. loadOffers() reconciles with the server either way.
            if action != "Counter" {
                offers.removeAll { $0.bestOfferId == offer.bestOfferId }
            }
            actionBanner = Self.banner(for: action)
            HapticFeedback.success()
            await loadOffers()
            return true
        } catch EdgeAPIError.offerNotOpen {
            // US-1510: the offer expired / was answered elsewhere while it sat in
            // a stale inbox. Not a failure to retry — tell the user calmly, drop
            // the dead row, and refresh so the list reflects reality. Returns
            // true so an open counter sheet dismisses (retrying can't succeed).
            offers.removeAll { $0.bestOfferId == offer.bestOfferId }
            actionBanner = "This offer is no longer open — refreshing your offers."
            HapticFeedback.warning()
            await loadOffers()
            return true
        } catch {
            actionError = error.localizedDescription
            HapticFeedback.error()
            return false
        }
    }

    /// US-1238: action-specific confirmation copy. A counter is NOT a resolution,
    /// so its banner makes clear the offer stays open until the buyer responds.
    private static func banner(for action: String) -> String {
        switch action {
        case "Accept": return "Offer accepted — the sale is confirmed."
        case "Decline": return "Offer declined."
        case "Counter": return "Counter sent — the offer stays open until the buyer responds."
        default: return "Offer \(action.lowercased())ed."
        }
    }

    /// US-1238: count listings eligible for a seller-initiated offer so the send
    /// sheet can show how many buyers the blast will reach before confirming.
    /// US-1510: the result distinguishes "the feature isn't available on this
    /// connection" (server 501 feature_unavailable — sending is a guaranteed
    /// failure, so the sheet must NOT say "you can still send") from a transient
    /// failure (unknown — degrade to the generic confirmation).
    func checkEligible() async -> EligibleCheck {
        do {
            let count = try await service.eligibleItems().count
            sendOfferUnavailable = false
            sendOfferUnavailableDetail = nil
            sendOfferNeedsReconnect = false
            return .count(count)
        } catch EdgeAPIError.featureUnavailable(let detail) {
            // US-1967: keep the reconnect flag from the capability probe — the
            // 501 body's copy already carries the distinction.
            markUnavailable(detail: detail, needsReconnect: sendOfferNeedsReconnect)
            return .unavailable(detail: detail)
        } catch {
            return .failed
        }
    }

    @discardableResult
    func sendOfferToAllEligible(discountPercentage: String, message: String?) async -> Bool {
        do {
            let eligible = try await service.eligibleItems()
            guard !eligible.isEmpty else {
                actionBanner = "No listings are currently eligible for an offer."
                HapticFeedback.warning()
                return true // not an error — nothing to send; let the sheet close
            }
            try await service.sendOffer(
                listingIds: eligible.map(\.listingId),
                discountPercentage: discountPercentage,
                message: message
            )
            actionBanner = "Sent \(discountPercentage)% offers to interested buyers on \(eligible.count) listing\(eligible.count == 1 ? "" : "s")."
            HapticFeedback.success()
            return true
        } catch let error as EdgeAPIError {
            // US-1510: a capability gate isn't a retryable failure — remember it
            // so the surface hides, and let errorDescription carry the calm copy.
            if case .featureUnavailable(let detail) = error {
                markUnavailable(detail: detail, needsReconnect: sendOfferNeedsReconnect)
            }
            actionError = error.localizedDescription
            HapticFeedback.error()
            return false
        } catch {
            actionError = error.localizedDescription
            HapticFeedback.error()
            return false
        }
    }

    func reply(to message: BuyerMessage, body: String) async -> Bool {
        guard let itemId = message.itemId, let recipient = message.senderUsername else {
            actionError = "This message can't be replied to in-app."
            HapticFeedback.error()
            return false
        }
        do {
            try await service.reply(
                messageId: message.messageId, itemId: itemId,
                recipientId: recipient, body: body
            )
            actionBanner = "Reply sent."
            HapticFeedback.success()
            await loadMessages()
            return true
        } catch {
            actionError = error.localizedDescription
            HapticFeedback.error()
            return false
        }
    }
}
