import Foundation

/// An incoming buyer best offer (US-673). Decoded via EdgeAPI's
/// convertFromSnakeCase decoder; the edge already returns camelCase keys, which
/// pass through unchanged.
struct BestOffer: Decodable, Identifiable, Equatable {
    let bestOfferId: String
    let itemId: String
    let itemTitle: String?
    let buyerUsername: String?
    let price: Double?
    let currency: String
    let quantity: Int?
    let status: String?
    let message: String?
    let expiresAt: String?

    var id: String { bestOfferId }

    init(
        bestOfferId: String, itemId: String, itemTitle: String? = nil,
        buyerUsername: String? = nil, price: Double? = nil, currency: String = "USD",
        quantity: Int? = nil, status: String? = nil, message: String? = nil,
        expiresAt: String? = nil
    ) {
        self.bestOfferId = bestOfferId
        self.itemId = itemId
        self.itemTitle = itemTitle
        self.buyerUsername = buyerUsername
        self.price = price
        self.currency = currency
        self.quantity = quantity
        self.status = status
        self.message = message
        self.expiresAt = expiresAt
    }
}

/// A buyer member-message (US-673).
struct BuyerMessage: Decodable, Identifiable, Equatable {
    let messageId: String
    let itemId: String?
    let senderUsername: String?
    let subject: String?
    let body: String?
    let creationDate: String?
    let answered: Bool

    var id: String { messageId }

    init(
        messageId: String, itemId: String? = nil, senderUsername: String? = nil,
        subject: String? = nil, body: String? = nil, creationDate: String? = nil,
        answered: Bool = false
    ) {
        self.messageId = messageId
        self.itemId = itemId
        self.senderUsername = senderUsername
        self.subject = subject
        self.body = body
        self.creationDate = creationDate
        self.answered = answered
    }
}

/// US-1967: whether this eBay connection can send offers to interested buyers.
/// The sell.negotiation scope isn't licensed on the production keyset, so those
/// endpoints 501 there — the inbox probes this on appear and hides the entry
/// point rather than shipping a button that always fails. Decoded via EdgeAPI's
/// convertFromSnakeCase decoder (`send_offer_available` → `sendOfferAvailable`).
struct NegotiationCapability: Decodable, Equatable {
    let sendOfferAvailable: Bool
    /// `feature_unavailable` (nothing the seller can do) or `reconnect_required`
    /// (a re-consent genuinely fixes it). Nil when the feature works.
    let code: String?
    /// Server-authored, seller-facing copy for the disabled state.
    let detail: String?

    var needsReconnect: Bool { code == "reconnect_required" }

    init(sendOfferAvailable: Bool, code: String? = nil, detail: String? = nil) {
        self.sendOfferAvailable = sendOfferAvailable
        self.code = code
        self.detail = detail
    }
}

/// A listing eligible for a seller-initiated offer to interested buyers.
struct EligibleNegotiationItem: Decodable, Identifiable, Equatable {
    let listingId: String
    let title: String?
    var id: String { listingId }
}
