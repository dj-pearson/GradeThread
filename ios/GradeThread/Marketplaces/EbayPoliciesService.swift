import Foundation

/// US-3102 — the seller's eBay business policies, for the composer's pickers.
///
/// Publish has always honoured a per-listing policy id, and bulk edit could set
/// one. The single-item composer on the phone could not: the three ids were
/// filled ONLY by an applied template (`ListingTemplate`), so changing shipping
/// for one heavy item meant a detour through the web or Seller Hub. That is the
/// most common per-listing edit there is, and it was the one thing the phone
/// could not do.
///
/// The cache is fifteen minutes and lives in memory. Policies change when a
/// seller edits them in Seller Hub, which is rare and never mid-composer; the
/// route itself already syncs from eBay when its own cache is empty, so a cold
/// read is a live sync and paying for one per composer open would be slow for
/// no benefit.

/// One business policy as the edge returns it (snake_case, decoded by
/// `EdgeAPI.shared`'s `.convertFromSnakeCase` decoder).
struct EbayBusinessPolicy: Decodable, Identifiable, Equatable {
    let policyId: String
    /// "fulfillment" | "payment" | "return".
    let policyType: String
    let policyName: String
    let isDefault: Bool

    var id: String { policyId }

    init(policyId: String, policyType: String, policyName: String, isDefault: Bool = false) {
        self.policyId = policyId
        self.policyType = policyType
        self.policyName = policyName
        self.isDefault = isDefault
    }
}

/// The account-level defaults publish falls back to when a listing names none.
struct EbayPolicyDefaults: Decodable, Equatable {
    let fulfillmentPolicyId: String?
    let paymentPolicyId: String?
    let returnPolicyId: String?
    /// Where the seller ships from. Not a policy, but the same route owns it and
    /// publish refuses without one, so it rides along.
    let merchantLocationKey: String?

    init(
        fulfillmentPolicyId: String? = nil,
        paymentPolicyId: String? = nil,
        returnPolicyId: String? = nil,
        merchantLocationKey: String? = nil
    ) {
        self.fulfillmentPolicyId = fulfillmentPolicyId
        self.paymentPolicyId = paymentPolicyId
        self.returnPolicyId = returnPolicyId
        self.merchantLocationKey = merchantLocationKey
    }
}

struct EbayPoliciesResponse: Decodable, Equatable {
    let policies: [EbayBusinessPolicy]
    let defaults: EbayPolicyDefaults

    init(policies: [EbayBusinessPolicy], defaults: EbayPolicyDefaults = EbayPolicyDefaults()) {
        self.policies = policies
        self.defaults = defaults
    }

    /// The policies of one type, in the order a picker should offer them:
    /// the account default first, then the rest by name.
    ///
    /// Default-first because it is the answer for almost every listing, and a
    /// seller scanning a picker on a phone should not have to hunt for the one
    /// they already chose once.
    func options(ofType type: String) -> [EbayBusinessPolicy] {
        policies
            .filter { $0.policyType == type }
            .sorted { lhs, rhs in
                if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
                return lhs.policyName.localizedCaseInsensitiveCompare(rhs.policyName) == .orderedAscending
            }
    }
}

/// The sync route's answer.
struct EbayPolicySyncResponse: Decodable {
    let synced: Int?
}

@MainActor
protocol EbayPoliciesProviding {
    func policies(forceRefresh: Bool) async throws -> EbayPoliciesResponse
    func sync() async throws -> EbayPoliciesResponse
}

@MainActor
final class EbayPoliciesService: EbayPoliciesProviding {
    /// Shared so two composers opened in one session do not each pay for a load.
    static let shared = EbayPoliciesService()

    /// Fifteen minutes. Long enough that opening the composer repeatedly costs
    /// nothing; short enough that a policy added in Seller Hub during a session
    /// shows up without a relaunch. "Sync policies" bypasses it entirely, which
    /// is the door for the seller who just made one.
    static let cacheTTL: TimeInterval = 15 * 60

    private var cached: EbayPoliciesResponse?
    private var cachedAt: Date?
    /// Coalesces concurrent loads: three pickers rendering at once must not be
    /// three requests.
    private var inFlight: Task<EbayPoliciesResponse, Error>?

    private let load: () async throws -> EbayPoliciesResponse
    private let runSync: () async throws -> Void
    private let now: () -> Date

    init(
        load: (() async throws -> EbayPoliciesResponse)? = nil,
        runSync: (() async throws -> Void)? = nil,
        now: @escaping () -> Date = { .now }
    ) {
        self.load = load ?? {
            try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/policies")
        }
        self.runSync = runSync ?? {
            let _: EbayPolicySyncResponse =
                try await EdgeAPI.shared.postJSON("/api/flipdesk/ebay/policies/sync", body: EmptyBody())
        }
        self.now = now
    }

    /// True when a cached answer is still worth serving.
    var hasFreshCache: Bool {
        guard let cachedAt else { return false }
        return now().timeIntervalSince(cachedAt) < Self.cacheTTL
    }

    func policies(forceRefresh: Bool = false) async throws -> EbayPoliciesResponse {
        if !forceRefresh, let cached, hasFreshCache { return cached }
        if let inFlight { return try await inFlight.value }

        let task = Task { [load] in try await load() }
        inFlight = task
        defer { inFlight = nil }

        let response = try await task.value
        cached = response
        cachedAt = now()
        return response
    }

    /// Re-pull from eBay, then re-read. Used by the "Sync policies" row, for the
    /// seller who just created a policy in Seller Hub and expects to see it.
    func sync() async throws -> EbayPoliciesResponse {
        try await runSync()
        // The cache is dropped BEFORE the read, not after: a sync that succeeded
        // and a read that then failed must not leave the stale list looking
        // freshly confirmed.
        cached = nil
        cachedAt = nil
        return try await policies(forceRefresh: true)
    }

    /// Sign-out, or a workspace switch. The next tenant's composer must not open
    /// on the last one's policies.
    func invalidate() {
        cached = nil
        cachedAt = nil
    }
}

/// `postJSON` needs a body; the sync route reads none.
private struct EmptyBody: Encodable {}
