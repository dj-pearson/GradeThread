import Foundation

/// GradeThread Verified edge client. Thin wrapper over `EdgeAPI.shared`
/// (auto-auth, snake_case ⇄ camelCase). Endpoints exist on the Hono service at
/// `/api/verified/*` and manage the caller's OWN seller profile (individual
/// account — no workspace scoping). Behind a protocol so the store is testable.
protocol VerifiedProviding {
    func profile() async throws -> VerifiedProfileResponse
    func checkHandle(_ handle: String) async throws -> HandleAvailability
    func update(_ body: VerifiedProfileUpdate) async throws -> VerifiedProfile
}

struct VerifiedService: VerifiedProviding {
    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    func profile() async throws -> VerifiedProfileResponse {
        try await api.getJSON("/api/verified/profile")
    }

    func checkHandle(_ handle: String) async throws -> HandleAvailability {
        try await api.getJSON(
            "/api/verified/handle-available",
            query: [URLQueryItem(name: "handle", value: handle)]
        )
    }

    func update(_ body: VerifiedProfileUpdate) async throws -> VerifiedProfile {
        let res: VerifiedProfileUpdateResponse =
            try await api.putJSON("/api/verified/profile", body: body)
        return res.profile
    }
}
