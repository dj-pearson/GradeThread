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
        case unavailable
        case failed
    }

    /// US-1510: sticky once the server reports feature_unavailable, so the
    /// send-offer toolbar entry can hide on subsequent visits instead of walking
    /// the user into a dead end again. Reset only on a successful probe (the
    /// feature reactivates automatically when the scope lands — US-1421).
    private(set) var sendOfferUnavailable = false

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
            return .count(count)
        } catch EdgeAPIError.featureUnavailable {
            sendOfferUnavailable = true
            return .unavailable
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
            if case .featureUnavailable = error { sendOfferUnavailable = true }
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
