import Foundation

// Referrals wire models. Mirror the web contract (`src/pages/referrals.tsx`) and
// the edge route `services/edge-functions/src/routes/referrals.ts`. Decoded via
// `EdgeAPI`'s shared decoder (snake_case → camelCase: `referred_by` → `referredBy`).

/// `GET /api/referrals/me`
struct ReferralMe: Decodable, Equatable {
    let code: String
    let stats: ReferralStats
    let referredBy: ReferredBy?
}

struct ReferralStats: Decodable, Equatable {
    let total: Int
    let pending: Int
    let qualified: Int
    let granted: Int
}

struct ReferredBy: Decodable, Equatable {
    let status: String
    let code: String
}

/// `POST /api/referrals/redeem`
struct RedeemResponse: Decodable, Equatable {
    let ok: Bool
}
