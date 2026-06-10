import Foundation

// GradeThread Verified — seller-profile wire models. Mirror the web hook
// (`src/hooks/use-verified.ts`) and the edge route `routes/verified.ts`.
// Decoded via `EdgeAPI`'s shared decoder (snake_case → camelCase:
// `display_name` → `displayName`, `total_graded` → `totalGraded`, etc.).
//
// `verifiedSince` is kept as a String (raw ISO timestamp) rather than Date: the
// edge serializes timestamps with fractional seconds, which the shared decoder's
// plain `.iso8601` date strategy doesn't parse — and it's display-only here.

/// `GET /api/verified/profile` → `{ profile, stats }`.
struct VerifiedProfileResponse: Decodable, Equatable {
    let profile: VerifiedProfile
    let stats: VerifiedStats
}

struct VerifiedProfile: Decodable, Equatable {
    let handle: String?
    let displayName: String?
    let bio: String?
    let enabled: Bool
    let verifiedSince: String?
    /// Storefront opt-in — when on (and `enabled`), the public page lists the
    /// seller's active listings. Decoded with a default so the app survives an
    /// edge that predates the field (rollout ordering).
    let showListings: Bool

    init(
        handle: String?,
        displayName: String?,
        bio: String?,
        enabled: Bool,
        verifiedSince: String?,
        showListings: Bool = false
    ) {
        self.handle = handle
        self.displayName = displayName
        self.bio = bio
        self.enabled = enabled
        self.verifiedSince = verifiedSince
        self.showListings = showListings
    }

    private enum CodingKeys: String, CodingKey {
        case handle, displayName, bio, enabled, verifiedSince, showListings
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = try c.decodeIfPresent(String.self, forKey: .handle)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        bio = try c.decodeIfPresent(String.self, forKey: .bio)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        verifiedSince = try c.decodeIfPresent(String.self, forKey: .verifiedSince)
        showListings = try c.decodeIfPresent(Bool.self, forKey: .showListings) ?? false
    }
}

struct VerifiedStats: Decodable, Equatable {
    let totalGraded: Int
    let averageGrade: Double
}

/// `GET /api/verified/handle-available?handle=` → `{ available, reason }`.
struct HandleAvailability: Decodable, Equatable {
    let available: Bool
    let reason: String?
}

/// `PUT /api/verified/profile` → `{ profile }`.
struct VerifiedProfileUpdateResponse: Decodable, Equatable {
    let profile: VerifiedProfile
}

/// Partial update body. Optional fields encode via `encodeIfPresent`, so `nil`
/// keys are omitted (server treats absent = "leave unchanged"); send `""` to
/// clear display name / bio.
struct VerifiedProfileUpdate: Encodable, Equatable {
    var handle: String?
    var displayName: String?
    var bio: String?
    var enabled: Bool?
    var showListings: Bool?
}
