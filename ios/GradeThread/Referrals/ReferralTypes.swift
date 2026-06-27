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
///
/// On success the edge returns `{ ok: true }`. On a business rejection (invalid /
/// self / already-referred / suspended code) the edge returns a 4xx whose body
/// carries a machine-readable `error_code`; `ReferralService` folds that into
/// `RedeemResponse(ok: false, reason:)` so the store can map it to specific copy
/// (US-1255) instead of one generic "that code isn't valid".
struct RedeemResponse: Decodable, Equatable {
    let ok: Bool
    /// Machine-readable rejection reason (`error_code`) when `ok == false`.
    let reason: String?

    init(ok: Bool, reason: String? = nil) {
        self.ok = ok
        self.reason = reason
    }
}

/// Maps the edge's redeem rejection `error_code` to specific, friendly copy.
/// Pure + unit-tested (US-1255) so the reason→message contract is verifiable
/// without the network. An unknown or absent reason falls back to `generic`.
enum RedeemRejection {
    static let generic = "That code isn't valid. Double-check it and try again."

    static func message(for reason: String?) -> String {
        switch reason {
        case "invalid_code", "not_found":
            return "We couldn't find that code. Double-check it and try again."
        case "self_referral":
            return "That's your own code — enter a friend's code instead."
        case "already_referred":
            return "You've already applied a referral code."
        case "expired":
            return "That code has expired. Ask your friend for a current one."
        case "account_suspended":
            return "Your account can't redeem a referral code right now."
        case "missing_code":
            return "Enter a code to continue."
        default:
            return generic
        }
    }
}
