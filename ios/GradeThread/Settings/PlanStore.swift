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
        let billing_source: String?
        let subscription_status: String?

        /// Statuses that keep a subscription entitled (mirrors the edge +
        /// `PaywallStore.entitlingStatuses`).
        private static let entitlingStatuses: Set<String> = ["active", "trialing", "past_due"]

        /// True when an active App Store subscription owns the plan — manage it
        /// natively (the system manage-subscriptions sheet) rather than routing
        /// to web billing (which can't manage an App Store-billed sub).
        var billedOnAppStore: Bool {
            billing_source == "appstore"
                && Self.entitlingStatuses.contains(subscription_status ?? "")
        }

        /// True ONLY for an existing web (Stripe) subscriber managing a live
        /// subscription: `billing_source == "stripe"` AND an entitling status.
        ///
        /// This is the sole gate for opening the web billing surface
        /// (gradethread.com/dashboard/billing). That page can create Stripe
        /// checkout sessions, so routing a FREE iOS user there would sell a
        /// digital subscription outside IAP — an App Store Guideline 3.1.1
        /// (anti-steering) violation (US-1207). Free users (no active sub,
        /// `billing_source != "stripe"`) must go to the StoreKit ``PaywallView``
        /// instead; App Store-billed users manage natively. Mirrors the edge
        /// `stripeSubscriptionEntitles` check (appstore/precedence.ts) but
        /// strictly requires `billing_source == "stripe"`.
        var isWebBilledSubscriber: Bool {
            billing_source == "stripe"
                && Self.entitlingStatuses.contains(subscription_status ?? "")
        }
    }

    enum Phase: Equatable {
        case loading
        case ready(PlanInfo)
        case failed(String)
    }

    private(set) var phase: Phase = .loading

    /// US-1407: re-entrancy guard so an overlapping `.task` + `.refreshable`
    /// can't run two loads at once and race the final `phase`.
    private var isLoading = false

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        phase = .loading
        do {
            let rows: [PlanInfo] = try await SupabaseShared.client
                .from("users")
                .select("flipdesk_plan, grade_credit_balance, grades_used_this_month, grade_reset_at, billing_source, subscription_status")
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
