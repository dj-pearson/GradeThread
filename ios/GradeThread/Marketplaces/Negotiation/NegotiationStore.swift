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
    /// Returns nil on failure so the sheet can degrade to a generic confirmation.
    func eligibleCount() async -> Int? {
        do {
            return try await service.eligibleItems().count
        } catch {
            return nil
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
