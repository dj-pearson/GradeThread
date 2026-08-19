import Foundation
import Observation
import Supabase

/// US-2533 — return-reduction analytics on the phone.
///
/// The rollup is the SAME one the web tab reads: `flipdesk_return_reduction`
/// (migration 00168), SECURITY INVOKER with execute granted to `authenticated`,
/// so RLS still scopes it to the caller and this client needs no new endpoint.
/// Nothing here re-derives the aggregation.
///
/// WHAT IS PORTED RATHER THAN CALLED, and why it is the risky half: the RPC
/// returns raw COUNTS, and the rules deciding whether a claim may be MADE live
/// in `src/lib/flipdesk-returns-analytics.ts`. Getting them wrong tells a paying
/// seller "your graded items return 3x less" off two sales, or renders a WORSE
/// number as a win, or prints an infinity from a zero divisor. Those are claims
/// about our own product's value, made to the person buying it.
///
/// So the three rules are reproduced exactly, and
/// `src/test/return-analytics-claim-rules.test.ts` asserts this file still
/// matches the TypeScript. The floor is the number most likely to drift, which
/// is why the guard reads it out of this source rather than trusting a comment.
@MainActor
@Observable
final class ReturnReductionStore {
    enum Phase: Equatable {
        case loading
        case ready(ReturnReductionSummary)
        case failed(String)
    }

    var phase: Phase = .loading

    var summary: ReturnReductionSummary? {
        if case let .ready(value) = phase { return value }
        return nil
    }

    private var isRefreshing = false

    /// `periodStart` is the analytics range's own start (AC3), formatted the way
    /// the RPC's `date` parameter expects. Nil means all time.
    func refresh(periodStart: Date?) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        phase = .loading
        struct Params: Encodable { let p_period_start: String? }
        do {
            let response = try await SupabaseShared.client
                .rpc(
                    "flipdesk_return_reduction",
                    params: Params(p_period_start: periodStart.map(Self.isoDay))
                )
                .execute()
            phase = .ready(
                try JSONDecoder().decode(ReturnReductionSummary.self, from: response.data)
            )
        } catch {
            phase = .failed(
                FriendlyErrorCopy.actionMessage(
                    for: error,
                    fallback: "Couldn't load return analytics. Please try again."
                )
            )
        }
    }

    /// UTC yyyy-MM-dd, matching the web wrapper. A device-local formatter would
    /// shift the window by a day either side of midnight for half the world, and
    /// the seller would see a different number on their phone than on their
    /// laptop for the same range.
    static func isoDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}

// MARK: - Wire shape

struct ReturnStat: Decodable, Equatable {
    /// Fulfilled sales (shipped: completed + refunded).
    let sold: Int
    let returns: Int
    /// returns / sold, nil when nothing sold. The RPC sends null rather than 0,
    /// and the difference matters: 0 is "nobody returned anything", null is
    /// "there is nothing to divide".
    let returnRate: Double?
}

struct ReturnBandRow: Decodable, Equatable, Identifiable {
    let key: String
    let label: String
    let sold: Int
    let returns: Int
    let returnRate: Double?

    var id: String { key }
}

struct ReturnReductionSummary: Decodable, Equatable {
    let overall: ReturnStat
    let graded: ReturnStat
    let ungraded: ReturnStat
    let bands: [ReturnBandRow]

    static let empty = ReturnReductionSummary(
        overall: ReturnStat(sold: 0, returns: 0, returnRate: nil),
        graded: ReturnStat(sold: 0, returns: 0, returnRate: nil),
        ungraded: ReturnStat(sold: 0, returns: 0, returnRate: nil),
        bands: []
    )
}

// MARK: - The claim rules

/// The editorial rules, as pure functions so they can be tested without a
/// session. Mirrors `src/lib/flipdesk-returns-analytics.ts`; change that first.
enum ReturnClaimRules {
    /// A band's return rate is only trustworthy once it has this many fulfilled
    /// sales behind it. MUST equal MIN_RETURN_SAMPLE in the TypeScript.
    static let minReturnSample = 10

    /// "Your graded items return Nx less often than ungraded." Nil unless both
    /// sides clear the floor AND graded actually returns less.
    static func gradedAdvantage(_ summary: ReturnReductionSummary) -> Double? {
        let graded = summary.graded
        let ungraded = summary.ungraded
        guard graded.sold >= minReturnSample, ungraded.sold >= minReturnSample else {
            return nil
        }
        guard let gradedRate = graded.returnRate, let ungradedRate = ungraded.returnRate else {
            return nil
        }
        // A zero graded rate would divide to infinity and render as
        // "Infinityx less"; a worse-or-equal ungraded rate is not a win.
        guard gradedRate > 0, ungradedRate > gradedRate else { return nil }
        return ungradedRate / gradedRate
    }

    struct BandComparison: Equatable {
        let multiplier: Double
        let low: ReturnBandRow
        let high: ReturnBandRow
    }

    /// "Items graded 6 and under come back Nx more often than your 8.5-10.0
    /// items." Same three rules, applied to the two bands.
    static func lowVsHigh(_ summary: ReturnReductionSummary) -> BandComparison? {
        guard let low = summary.bands.first(where: { $0.key == "low" }),
              let high = summary.bands.first(where: { $0.key == "high" })
        else { return nil }
        guard low.sold >= minReturnSample, high.sold >= minReturnSample else { return nil }
        guard let lowRate = low.returnRate, let highRate = high.returnRate else { return nil }
        guard highRate > 0, lowRate > highRate else { return nil }
        return BandComparison(multiplier: lowRate / highRate, low: low, high: high)
    }

    /// True when a band has sales but too few to appear in a headline. The web
    /// tab still SHOWS the row and marks it; hiding it would leave the seller
    /// wondering where a grade band went.
    static func isLowSample(_ band: ReturnBandRow) -> Bool {
        band.sold > 0 && band.sold < minReturnSample
    }
}
