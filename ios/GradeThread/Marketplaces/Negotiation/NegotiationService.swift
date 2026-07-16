import Foundation

/// Edge client for eBay best-offers + buyer messages (US-673). All calls hit the
/// consolidated edge service, which resolves the caller's eBay token, so there's
/// no cross-tenant surface. Behind a protocol so ``NegotiationStore`` is testable.
protocol NegotiationProviding {
    func offers() async throws -> [BestOffer]
    func respond(bestOfferId: String, itemId: String, action: String, counterPrice: Double?, message: String?) async throws
    /// US-1967: cheap capability probe — can this connection send offers at all?
    func capability() async throws -> NegotiationCapability
    func eligibleItems() async throws -> [EligibleNegotiationItem]
    func sendOffer(listingIds: [String], discountPercentage: String, message: String?) async throws
    func messages() async throws -> [BuyerMessage]
    func reply(messageId: String, itemId: String, recipientId: String, body: String) async throws
}

struct NegotiationService: NegotiationProviding {
    private struct OffersResponse: Decodable { let offers: [BestOffer] }
    private struct MessagesResponse: Decodable { let messages: [BuyerMessage] }
    private struct EligibleResponse: Decodable { let items: [EligibleNegotiationItem] }
    private struct OKResponse: Decodable { let ok: Bool? }

    func offers() async throws -> [BestOffer] {
        let resp: OffersResponse = try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/negotiation/offers")
        return resp.offers
    }

    func respond(
        bestOfferId: String, itemId: String, action: String,
        counterPrice: Double?, message: String?
    ) async throws {
        struct Body: Encodable {
            let itemId: String
            let action: String
            let counterPrice: Double?
            let message: String?
        }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/negotiation/offers/\(bestOfferId)/respond",
            body: Body(itemId: itemId, action: action, counterPrice: counterPrice, message: message)
        )
    }

    func capability() async throws -> NegotiationCapability {
        try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/negotiation/capabilities")
    }

    func eligibleItems() async throws -> [EligibleNegotiationItem] {
        let resp: EligibleResponse = try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/negotiation/eligible")
        return resp.items
    }

    func sendOffer(listingIds: [String], discountPercentage: String, message: String?) async throws {
        struct Body: Encodable {
            let listingIds: [String]
            let discountPercentage: String
            let message: String?
        }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/negotiation/send-offer",
            body: Body(listingIds: listingIds, discountPercentage: discountPercentage, message: message)
        )
    }

    func messages() async throws -> [BuyerMessage] {
        let resp: MessagesResponse = try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/messages")
        return resp.messages
    }

    func reply(messageId: String, itemId: String, recipientId: String, body: String) async throws {
        struct Body: Encodable {
            let itemId: String
            let recipientId: String
            let body: String
        }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/messages/\(messageId)/reply",
            body: Body(itemId: itemId, recipientId: recipientId, body: body)
        )
    }
}
