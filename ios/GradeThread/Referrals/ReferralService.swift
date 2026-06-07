import Foundation

/// Referrals edge client. Thin wrapper over `EdgeAPI.shared` (auto-auth,
/// snake_case ⇄ camelCase). Endpoints exist on the Hono service at
/// `/api/referrals/*`. Behind a protocol so the store is unit-testable with an
/// in-memory mock.
protocol ReferralProviding {
    func me() async throws -> ReferralMe
    func redeem(code: String) async throws -> RedeemResponse
}

struct ReferralService: ReferralProviding {
    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    func me() async throws -> ReferralMe {
        try await api.getJSON("/api/referrals/me")
    }

    func redeem(code: String) async throws -> RedeemResponse {
        struct Body: Encodable { let code: String }
        return try await api.postJSON("/api/referrals/redeem", body: Body(code: code))
    }
}
