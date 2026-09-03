import Foundation

/// Post-sale eBay issues (US-1043 / US-1049). Decoded via EdgeAPI's
/// convertFromSnakeCase decoder; the edge returns camelCase keys, which pass
/// through unchanged.

/// An open return request.
struct EbayReturn: Decodable, Identifiable, Equatable {
    let returnId: String
    let state: String?
    let orderId: String?
    let itemId: String?
    let reason: String?
    let creationDate: String?
    /// US-3101: the date eBay decides this for you if you do not.
    ///
    /// The edge has sent it since US-2933 (`respondBy` in lib/ebay-postorder.ts)
    /// and this type dropped it, so the one field on a return that costs money
    /// to ignore never reached the phone. Optional: eBay omits it on some
    /// returns, and an absent deadline is a real state, not a parse failure.
    let respondBy: String?

    var id: String { returnId }

    init(
        returnId: String, state: String? = nil, orderId: String? = nil,
        itemId: String? = nil, reason: String? = nil, creationDate: String? = nil,
        respondBy: String? = nil
    ) {
        self.returnId = returnId
        self.state = state
        self.orderId = orderId
        self.itemId = itemId
        self.reason = reason
        self.creationDate = creationDate
        self.respondBy = respondBy
    }
}

/// An open buyer cancellation request.
struct EbayCancellation: Decodable, Identifiable, Equatable {
    let cancelId: String
    let state: String?
    let orderId: String?
    let reason: String?
    let requestorType: String?
    let creationDate: String?

    var id: String { cancelId }

    init(
        cancelId: String, state: String? = nil, orderId: String? = nil,
        reason: String? = nil, requestorType: String? = nil, creationDate: String? = nil
    ) {
        self.cancelId = cancelId
        self.state = state
        self.orderId = orderId
        self.reason = reason
        self.requestorType = requestorType
        self.creationDate = creationDate
    }
}

/// An open payment dispute (buyer case / chargeback).
struct EbayPaymentDispute: Decodable, Identifiable, Equatable {
    let paymentDisputeId: String
    let orderId: String?
    let status: String?
    let reason: String?
    let amount: Double?
    let currency: String?
    let openedDate: String?
    let respondByDate: String?
    let buyerUsername: String?

    var id: String { paymentDisputeId }

    init(
        paymentDisputeId: String, orderId: String? = nil, status: String? = nil,
        reason: String? = nil, amount: Double? = nil, currency: String? = nil,
        openedDate: String? = nil, respondByDate: String? = nil, buyerUsername: String? = nil
    ) {
        self.paymentDisputeId = paymentDisputeId
        self.orderId = orderId
        self.status = status
        self.reason = reason
        self.amount = amount
        self.currency = currency
        self.openedDate = openedDate
        self.respondByDate = respondByDate
        self.buyerUsername = buyerUsername
    }
}
