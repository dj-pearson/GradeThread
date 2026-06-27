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
        let bodyData = try JSONEncoder.iso8601.encode(Body(code: code))
        let (status, data) = try await api.postForStatus("/api/referrals/redeem", bodyData: bodyData)

        if (200..<300).contains(status) {
            // Tolerate a missing/garbled body on success — the redemption took.
            return (try? JSONDecoder.iso8601.decode(RedeemResponse.self, from: data))
                ?? RedeemResponse(ok: true)
        }

        // US-1255: read the machine-readable reason the edge tagged the 4xx with.
        let wire = try? JSONDecoder().decode(RedeemErrorWire.self, from: data)
        // A genuine auth/infra failure (no domain reason) is surfaced as a thrown
        // error so the store's catch shows the right recovery copy — a 401 must
        // read as "sign in again", not "bad code". A 4xx that DOES carry a reason
        // (e.g. a 403 suspended) is a business rejection → fold it into the body.
        if wire?.error_code == nil, status == 401 || status == 403 || status >= 500 {
            throw EdgeAPIError.from(statusCode: status, body: data)
        }
        return RedeemResponse(ok: false, reason: wire?.error_code)
    }
}

/// The edge's redeem error envelope. `error_code` is the machine-readable
/// rejection reason (US-1255); `error` is the human fallback message.
private struct RedeemErrorWire: Decodable {
    let error: String?
    let error_code: String?
}
