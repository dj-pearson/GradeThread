import Foundation

/// US-3103 — pushing one draft to several marketplaces from the phone.
///
/// Two mechanisms behind one action, and the difference is stated to the seller
/// rather than smoothed over:
///
///  - **API channels** are published server-side. `POST /api/flipdesk/listings/
///    cross-push` returns when the marketplace has the listing, so "listed"
///    means listed and the result carries a URL.
///  - **Extension channels** cannot be published from a phone at all. The
///    servers hold no marketplace session by design
///    (`vault/60-decisions/adr-no-server-side-marketplace-automation.md`), so
///    the phone QUEUES a job the seller's own desktop browser runs later. That
///    may be hours. Reporting it as "cross-posted" would be a lie with a clock
///    on it.

/// What one platform's push did.
struct CrossPushOutcome: Identifiable, Equatable {
    enum State: Equatable {
        /// Live on the marketplace now, with its URL when the server sent one.
        case listed(url: String?)
        /// Waiting for the seller's desktop browser.
        case queued
        case failed(String)
    }

    let platform: String
    let state: State

    var id: String { platform }
}

/// The cross-push route's per-platform answer.
///
/// NOTE the shape: `results` is an OBJECT KEYED BY PLATFORM, not an array
/// (`Partial<Record<CrossListingPlatform, PlatformPushResult>>` in
/// routes/flipdesk-listings.ts). Decoding it as an array is the kind of mistake
/// that yields an empty list and reads as "nothing happened" rather than as a
/// parse failure, so the shape is written out here rather than assumed.
struct CrossPushResultRow: Decodable, Equatable {
    let ok: Bool?
    let listingUrl: String?
    let error: String?
    /// Per-platform blockers from the adapter's own pre-flight, when it refused
    /// before calling the marketplace at all.
    let blockers: [String]?
}

struct CrossPushResponse: Decodable, Equatable {
    let ok: Bool?
    let results: [String: CrossPushResultRow]?
}

/// The body `src/hooks/use-cross-listing.ts` sends, field for field.
struct CrossPushRequest: Encodable, Equatable {
    let listingId: String
    let platforms: [String]
    /// Dollars as strings, per platform. Omitted entirely when the seller typed
    /// no override anywhere — the route reads a missing key as "use the
    /// listing's own price", and sending an empty object to say the same thing
    /// is a difference the two clients would have to keep in step for nothing.
    let prices: [String: String]?

    enum CodingKeys: String, CodingKey {
        case listingId = "listing_id"
        case platforms
        case prices
    }
}

@MainActor
protocol CrossPushProviding {
    func push(_ request: CrossPushRequest) async throws -> CrossPushResponse
    func enqueueExtension(platform: String, itemId: String, price: String?) async throws
}

@MainActor
struct CrossPushService: CrossPushProviding {
    private let queue: ExtensionQueueService

    init(queue: ExtensionQueueService = ExtensionQueueService()) {
        self.queue = queue
    }

    func push(_ request: CrossPushRequest) async throws -> CrossPushResponse {
        try await EdgeAPI.shared.postJSON("/api/flipdesk/listings/cross-push", body: request)
    }

    func enqueueExtension(platform: String, itemId: String, price: String?) async throws {
        // The per-platform price rides in the payload rather than being resolved
        // later. US-3096 hydrates a `list` row at claim time and merges the
        // hydrated content UNDER whatever the client sent, so a price typed here
        // survives; without it the desktop would fill the item's own price and
        // silently discard the override the seller typed on the phone.
        var payload: [String: String] = [:]
        if let price, !price.isEmpty { payload["price"] = price }
        try await queue.enqueue(
            kind: .list,
            platform: platform,
            inventoryItemId: itemId,
            payload: payload
        )
    }
}

/// Turns what the seller picked into what to send, and what came back into what
/// to show. Pure, so both halves are testable without a network.
enum CrossPush {

    /// Dollars typed by a human, normalized for the wire.
    ///
    /// Blank means "use the listing price" — which is the DEFAULT and the
    /// common case, so a blank field must produce no key at all rather than an
    /// empty string the route would have to interpret.
    static func priceEntry(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let value = Double(trimmed), value > 0 else { return nil }
        // Two decimals, always: a marketplace price is money, and "12.5" and
        // "12.50" being the same number does not make them the same string in a
        // request body someone will read in a log.
        return String(format: "%.2f", value)
    }

    /// Build the API-channel request. Nil when nothing API-shaped was picked.
    static func request(
        listingId: String,
        platforms: [String],
        priceTexts: [String: String]
    ) -> CrossPushRequest? {
        guard !platforms.isEmpty else { return nil }
        var prices: [String: String] = [:]
        for platform in platforms {
            if let entry = priceEntry(priceTexts[platform] ?? "") {
                prices[platform] = entry
            }
        }
        return CrossPushRequest(
            listingId: listingId,
            platforms: platforms,
            prices: prices.isEmpty ? nil : prices
        )
    }

    /// Read the route's answer into per-platform outcomes.
    ///
    /// A platform that was asked for and is MISSING from the response is
    /// reported failed, not quietly dropped: the seller asked for four channels
    /// and must be told about four.
    static func outcomes(
        requested: [String],
        response: CrossPushResponse
    ) -> [CrossPushOutcome] {
        let byPlatform = response.results ?? [:]
        return requested.map { platform in
            guard let row = byPlatform[platform] else {
                return CrossPushOutcome(
                    platform: platform,
                    state: .failed(String(localized: "The server did not say what happened here. Check the item before trying again."))
                )
            }
            if row.ok == true {
                return CrossPushOutcome(platform: platform, state: .listed(url: row.listingUrl))
            }
            // A blocker is the adapter refusing BEFORE it called the
            // marketplace — a missing size, no photos — and it names the fix,
            // so it beats the generic error when both are present.
            let reason = row.blockers?.first
                ?? row.error
                ?? String(localized: "Could not list on this marketplace.")
            return CrossPushOutcome(platform: platform, state: .failed(reason))
        }
    }
}
