import Foundation
import Observation
import Supabase

/// US-1064: loads the anonymized community benchmarks (the `community_benchmarks`
/// RPC, 00173) and derives sourcing/pricing recommendations for the iOS insights
/// surface. The RPC is SECURITY DEFINER and aggregates platform-wide but only
/// ever returns k-anonymous cohorts + the caller's own numbers, so no per-seller
/// data leaks. Decoding mirrors ``ExpenseStore``'s resilient pattern.
@MainActor
@Observable
final class CommunityInsightsStore {
    enum Phase: Equatable {
        case loading
        case ready(CommunityBenchmarks)
        case failed(String)
    }

    var phase: Phase = .loading

    var benchmarks: CommunityBenchmarks? {
        if case let .ready(data) = phase { return data }
        return nil
    }

    var recommendations: [CommunityRecommendation] {
        guard let benchmarks else { return [] }
        return CommunityRecommendations.derive(benchmarks)
    }

    /// Trailing-12-month window — the most decision-relevant horizon for
    /// "what should I be sourcing now". Trending categories always use the RPC's
    /// fixed last-30d-vs-prior-30d window regardless.
    private static func last12moStart(now: Date = .now) -> String {
        let start = Calendar.current.date(byAdding: .day, value: -365, to: now) ?? now
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: start)
    }

    func refresh() async {
        phase = .loading
        struct Params: Encodable { let p_period_start: String? }
        do {
            let response = try await SupabaseShared.client
                .rpc("community_benchmarks", params: Params(p_period_start: Self.last12moStart()))
                .execute()
            let decoder = JSONDecoder()
            let data = try decoder.decode(CommunityBenchmarks.self, from: response.data)
            phase = .ready(data)
        } catch {
            // US-1174: friendly copy instead of a raw decode/network error.
            phase = .failed(FriendlyErrorCopy.actionMessage(for: error, fallback: "Couldn't load insights. Please try again."))
        }
    }
}
