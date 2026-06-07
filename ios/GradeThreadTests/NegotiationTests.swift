import XCTest
@testable import GradeThread

/// US-673: best-offers + buyer-messages store + decode.
@MainActor
final class NegotiationTests: XCTestCase {

    // MARK: - Decode (EdgeAPI uses convertFromSnakeCase; edge returns camelCase)

    func test_bestOffer_decodes() throws {
        let json = #"""
        {
          "bestOfferId": "bo1", "itemId": "i1", "itemTitle": "Jacket",
          "buyerUsername": "buyer_x", "price": 42.5, "currency": "USD",
          "quantity": 1, "status": "Active", "message": "Will you take this?",
          "expiresAt": "2026-06-10T00:00:00Z"
        }
        """#
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let offer = try d.decode(BestOffer.self, from: Data(json.utf8))
        XCTAssertEqual(offer.bestOfferId, "bo1")
        XCTAssertEqual(offer.price, 42.5)
        XCTAssertEqual(offer.buyerUsername, "buyer_x")
    }

    func test_buyerMessage_decodes() throws {
        let json = #"""
        {"messageId":"m1","itemId":"i1","senderUsername":"buyer_x","subject":"Q","body":"Is this authentic?","creationDate":"2026-06-01T00:00:00Z","answered":false}
        """#
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let msg = try d.decode(BuyerMessage.self, from: Data(json.utf8))
        XCTAssertEqual(msg.messageId, "m1")
        XCTAssertEqual(msg.senderUsername, "buyer_x")
        XCTAssertFalse(msg.answered)
    }

    // MARK: - Store

    func test_store_loadsOffersAndMessages() async {
        let fake = FakeNegotiation(
            offers: [.init(bestOfferId: "bo1", itemId: "i1", price: 20)],
            messages: [.init(messageId: "m1", itemId: "i1", senderUsername: "b")]
        )
        let store = NegotiationStore(service: fake)
        await store.loadOffers()
        await store.loadMessages()
        XCTAssertEqual(store.offersPhase, .ready)
        XCTAssertEqual(store.offers.count, 1)
        XCTAssertEqual(store.messages.count, 1)
    }

    func test_store_acceptRemovesOffer() async {
        let fake = FakeNegotiation(offers: [.init(bestOfferId: "bo1", itemId: "i1")])
        let store = NegotiationStore(service: fake)
        await store.loadOffers()
        await store.accept(store.offers[0])
        XCTAssertEqual(fake.respondCalls.last?.action, "Accept")
        XCTAssertTrue(store.offers.isEmpty)
    }

    func test_store_counterPassesPrice() async {
        let fake = FakeNegotiation(offers: [.init(bestOfferId: "bo1", itemId: "i1")])
        let store = NegotiationStore(service: fake)
        await store.loadOffers()
        await store.counter(store.offers[0], price: 33, message: "best I can do")
        XCTAssertEqual(fake.respondCalls.last?.action, "Counter")
        XCTAssertEqual(fake.respondCalls.last?.counterPrice, 33)
    }

    func test_store_replyRequiresItemAndSender() async {
        let fake = FakeNegotiation(messages: [.init(messageId: "m1", itemId: nil, senderUsername: nil)])
        let store = NegotiationStore(service: fake)
        await store.loadMessages()
        let ok = await store.reply(to: store.messages[0], body: "hi")
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.actionError)
        XCTAssertTrue(fake.replyCalls.isEmpty)
    }

    func test_store_replySendsWhenAddressable() async {
        let fake = FakeNegotiation(messages: [.init(messageId: "m1", itemId: "i1", senderUsername: "buyer")])
        let store = NegotiationStore(service: fake)
        await store.loadMessages()
        let ok = await store.reply(to: store.messages[0], body: "thanks!")
        XCTAssertTrue(ok)
        XCTAssertEqual(fake.replyCalls.last?.recipientId, "buyer")
    }

    func test_store_sendOfferToAllEligible() async {
        let fake = FakeNegotiation(eligible: [
            .init(listingId: "l1", title: "A"), .init(listingId: "l2", title: "B"),
        ])
        let store = NegotiationStore(service: fake)
        await store.sendOfferToAllEligible(discountPercentage: "15", message: nil)
        XCTAssertEqual(fake.sendOfferCalls.last?.listingIds, ["l1", "l2"])
        XCTAssertEqual(fake.sendOfferCalls.last?.discount, "15")
    }

    // MARK: - Fake

    final class FakeNegotiation: NegotiationProviding, @unchecked Sendable {
        var offersList: [BestOffer]
        var messagesList: [BuyerMessage]
        var eligible: [EligibleNegotiationItem]
        var respondCalls: [(action: String, counterPrice: Double?)] = []
        var replyCalls: [(messageId: String, recipientId: String)] = []
        var sendOfferCalls: [(listingIds: [String], discount: String)] = []

        init(
            offers: [BestOffer] = [], messages: [BuyerMessage] = [],
            eligible: [EligibleNegotiationItem] = []
        ) {
            self.offersList = offers
            self.messagesList = messages
            self.eligible = eligible
        }

        func offers() async throws -> [BestOffer] { offersList }
        func messages() async throws -> [BuyerMessage] { messagesList }
        func eligibleItems() async throws -> [EligibleNegotiationItem] { eligible }

        func respond(bestOfferId: String, itemId: String, action: String, counterPrice: Double?, message: String?) async throws {
            respondCalls.append((action, counterPrice))
            offersList.removeAll { $0.bestOfferId == bestOfferId }
        }

        func sendOffer(listingIds: [String], discountPercentage: String, message: String?) async throws {
            sendOfferCalls.append((listingIds, discountPercentage))
        }

        func reply(messageId: String, itemId: String, recipientId: String, body: String) async throws {
            replyCalls.append((messageId, recipientId))
        }
    }
}
