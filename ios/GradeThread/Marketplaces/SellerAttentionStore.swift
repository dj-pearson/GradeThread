import Foundation
import Observation

/// US-3101 — the number on the Marketplaces tab: what eBay is waiting on.
///
/// Home already carried an unread-notification badge. The count that decides
/// whether a seller LOSES MONEY was on a different tab and had no badge at all:
/// an offer expires unanswered, a return runs past its respond-by date and eBay
/// decides it for you. Both are clocks the seller loses by default, and neither
/// was visible without opening Marketplaces and looking.
///
/// Modelled on ``UnreadBadgeStore`` — same shell-level shape, same injected
/// fetches so every path is testable without a network, same rule that a failed
/// refresh KEEPS the last count rather than reporting zero. Where they differ:
///
/// **This one counts DEADLINES, not items.** A return with no respond-by date
/// is not urgent in the sense this badge means — eBay is running no clock on it
/// — so it is not counted, matching the undated-last rule in the web's
/// `rankNeedsYou` (src/pages/flipdesk/needs-you.ts). Counting everything open
/// would make the badge a number that never reaches zero, which is a number
/// people stop reading.
///
/// **It refreshes on foreground only, and only when eBay is connected.** Each
/// refresh is real eBay API calls against an app-wide rate limit, so this is not
/// something to poll.
@MainActor
@Observable
public final class SellerAttentionStore {
    /// Offers awaiting a reply plus returns and cases with a deadline.
    public private(set) var count: Int = 0

    /// What the tab badge renders. **Nil at zero, never 0.**
    ///
    /// A badge showing "0" is worse than no badge: it draws the eye to say
    /// nothing is wrong, which is the opposite of what a badge is for.
    public var badgeCount: Int? { count > 0 ? count : nil }

    private let fetchCounts: () async throws -> SellerAttentionCounts
    private var isRefreshing = false

    public init(fetchCounts: (() async throws -> SellerAttentionCounts)? = nil) {
        self.fetchCounts = fetchCounts ?? { try await SellerAttentionCounts.load() }
    }

    /// Refreshes. No-op while one is in flight; on failure the last count
    /// stands, because a network blip is not "nothing needs you".
    public func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            count = try await fetchCounts().total
        } catch {
            // Keep the last known value, deliberately. See the note above.
        }
    }

    /// Sign-out. The next user's badge must not start at the last one's number.
    public func reset() {
        count = 0
    }
}

/// The raw counts behind the badge, and the one rule that turns them into it.
///
/// A struct rather than an Int so the rule is testable on its own and so a
/// future surface (the US-3080 attention strip) can show the breakdown without
/// re-deriving it from a total.
public struct SellerAttentionCounts: Equatable, Sendable {
    /// Offers a buyer is waiting on an answer to. Every one is a live sale.
    public let offersAwaitingReply: Int
    /// Returns with a respond-by date that has not passed.
    public let returnsWithDeadline: Int
    /// Payment disputes with a respond-by date that has not passed.
    public let disputesWithDeadline: Int

    public init(offersAwaitingReply: Int, returnsWithDeadline: Int, disputesWithDeadline: Int) {
        self.offersAwaitingReply = offersAwaitingReply
        self.returnsWithDeadline = returnsWithDeadline
        self.disputesWithDeadline = disputesWithDeadline
    }

    public var total: Int {
        offersAwaitingReply + returnsWithDeadline + disputesWithDeadline
    }

    /// PURE: count what is genuinely waiting, from what the routes returned.
    ///
    /// `now` is a parameter so the deadline arithmetic is testable without
    /// waiting for a clock — a past deadline is no longer something the seller
    /// can act on before eBay does, so it does not sit in a badge implying they
    /// still can.
    public static func from(
        offers: [BestOffer],
        returns: [EbayReturn],
        disputes: [EbayPaymentDispute],
        now: Date = .now
    ) -> SellerAttentionCounts {
        SellerAttentionCounts(
            // A pending offer is one nobody has answered. eBay's other states
            // (accepted, declined, expired) are decisions already made.
            offersAwaitingReply: offers.filter { ($0.status ?? "").uppercased() == "PENDING" }.count,
            returnsWithDeadline: returns.filter { isLive($0.respondBy, now: now) }.count,
            disputesWithDeadline: disputes.filter { isLive($0.respondByDate, now: now) }.count
        )
    }

    /// A deadline that exists and has not passed.
    ///
    /// An ABSENT date is not counted. eBay is running no clock on that row, so
    /// it is genuinely less urgent than one it is — the same call the web's
    /// ranking makes when it sorts undated items last.
    private static func isLive(_ iso: String?, now: Date) -> Bool {
        guard let iso, let date = ISO8601DateParser.date(from: iso) else { return false }
        return date > now
    }

    /// Loads all three from the edge, concurrently.
    ///
    /// Any one failing takes the whole refresh down rather than reporting a
    /// partial number: a badge that quietly drops the returns because one call
    /// timed out is a badge that says the seller has less to do than they do.
    static func load() async throws -> SellerAttentionCounts {
        async let offers = NegotiationService().offers()
        async let returns = PostSaleService().returns()
        async let disputes = PostSaleService().disputes()
        return from(offers: try await offers, returns: try await returns, disputes: try await disputes)
    }
}

/// ISO-8601 parsing that accepts eBay's two spellings.
///
/// eBay returns fractional seconds on some payloads and not others, and
/// `ISO8601DateFormatter` with the wrong options returns nil rather than
/// throwing — so a deadline silently became "no deadline" and the row dropped
/// out of the count.
enum ISO8601DateParser {
    private static let withFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func date(from iso: String) -> Date? {
        withFractional.date(from: iso) ?? plain.date(from: iso)
    }
}
