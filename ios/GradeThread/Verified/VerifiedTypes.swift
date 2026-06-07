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
}
