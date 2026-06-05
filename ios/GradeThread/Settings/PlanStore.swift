import Foundation
import SwiftUI

/// Reads the signed-in user's FlipDesk plan + grade economics for the
/// Settings "Plan & credits" section. RLS scopes the `users` read to the
/// caller's own row (same pattern as ``ProfileStore``).
@MainActor
@Observable
final class PlanStore {

    /// Subset of `users` we surface. snake_case to match the column names —
    /// the Supabase client decoder doesn't convert keys.
    struct PlanInfo: Decodable, Equatable {
        let flipdesk_plan: String?
        let grade_credit_balance: Int?
        let grades_used_this_month: Int?
        let grade_reset_at: String?
    }

    enum Phase: Equatable {
        case loading
        case ready(PlanInfo)
        case failed(String)
    }

    private(set) var phase: Phase = .loading

    func load() async {
        phase = .loading
        do {
            let rows: [PlanInfo] = try await SupabaseShared.client
                .from("users")
                .select("flipdesk_plan, grade_credit_balance, grades_used_this_month, grade_reset_at")
                .limit(1)
                .execute()
                .value
            if let info = rows.first {
                phase = .ready(info)
            } else {
                phase = .failed("Couldn't find your account.")
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

/// Plan-derived grade limits. Mirrors `INCLUDED_STANDARD_PER_MONTH` in the
/// edge service (grade-pricing.ts). Kept here as stable config so Settings
/// can show "included grades left" without a round-trip through a grade
/// submission.
enum GradePlanLimits {
    static let includedStandardPerMonth: [String: Int] = [
        "free": 3, "starter": 10, "pro": 30, "business": 75,
    ]

    /// (used, cap) for the plan, applying the monthly reset. Returns nil for
    /// an unknown plan so the caller can hide the row rather than guess.
    static func includedUsage(
        plan: String?,
        gradesUsed: Int?,
        resetAt: String?,
        now: Date = .now
    ) -> (used: Int, cap: Int)? {
        guard let plan, let cap = includedStandardPerMonth[plan.lowercased()] else { return nil }
        // If the monthly window already rolled over, the server treats usage
        // as zero until the next grade resets the counter (mirror that).
        let used: Int
        if let resetAt, let resetDate = Self.parseISO(resetAt), resetDate <= now {
            used = 0
        } else {
            used = max(0, gradesUsed ?? 0)
        }
        return (min(used, cap), cap)
    }

    private static func parseISO(_ string: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}
