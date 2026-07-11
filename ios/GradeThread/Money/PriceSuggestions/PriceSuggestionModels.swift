import Foundation
import GradeThreadCore

/// US-816 — pure model + candidate/suggestion logic for the bulk
/// price-suggestions surface (iOS parity with web `/dashboard/analytics/
/// suggestions`). Kept free of SwiftData / network so it unit-tests with no
/// host: the view maps `LocalInventoryItem` / `LocalListing` into the
/// lightweight snapshots below, then this file decides who's a candidate.

/// Why an item surfaced in the suggestions list.
enum PriceSuggestionReason: Equatable {
    /// No `target_price` set yet — never been priced.
    case noTargetPrice
    /// Has an active listing first listed `days` ago (stale; consider repricing).
    case staleListing(days: Int)

    var label: String {
        switch self {
        case .noTargetPrice: return "No price set"
        case let .staleListing(days): return "Listed \(days)d ago"
        }
    }
}

/// A read-only snapshot of an inventory item — just the fields the candidate
/// logic reads, so tests don't need a `@Model` / `ModelContext`.
struct PriceSuggestionItemSnapshot: Equatable {
    let id: String
    let title: String
    let brand: String?
    let size: String?
    let status: String
    let targetPrice: Double?
    let listingPrice: Double?
}

/// A read-only snapshot of a `listings` row for the same purpose.
struct PriceSuggestionListingSnapshot: Equatable {
    let inventoryItemId: String
    let listingStatus: String
    let listingPrice: Double
    let listedAt: Date?
}

/// An item that needs (re)pricing, with the context the row renders.
struct PriceSuggestionCandidate: Identifiable, Equatable {
    let id: String            // inventory item id
    let title: String
    let brand: String?
    let size: String?
    /// Highest active-listing price, or the cached `listingPrice`, else nil.
    let currentPrice: Double?
    /// A draft listing exists → Apply also pushes the price to the draft.
    let hasDraft: Bool
    let reason: PriceSuggestionReason
}

/// The comps-derived suggestion for a candidate (median + spread + count).
struct PriceSuggestion: Equatable {
    let suggestedPrice: Double   // median comp, cents-normalized
    let compCount: Int
    let low: Double?             // p25 ?? min
    let high: Double?            // p75 ?? max
    let categoryPath: String

    /// Builds a suggestion from a resolved comps lookup, or nil when eBay
    /// returned no comparable sold/active listings (no median to anchor on).
    static func from(lookup: CompsLookup) -> PriceSuggestion? {
        guard lookup.stats.count > 0, let median = lookup.stats.median, median > 0 else {
            return nil
        }
        return PriceSuggestion(
            suggestedPrice: Money.cents(median),
            compCount: lookup.stats.count,
            low: lookup.stats.p25 ?? lookup.stats.min,
            high: lookup.stats.p75 ?? lookup.stats.max,
            categoryPath: lookup.categoryPath
        )
    }
}

enum PriceSuggestions {
    /// Item statuses that are terminal for pricing — already sold or retired,
    /// so they never need a suggestion.
    static let terminalStatuses: Set<String> = ["sold", "shipped", "archived"]

    /// Listing statuses that count as a live, repriceable listing for staleness.
    private static let activeStatuses: Set<String> = ["active", "listed", "relisted"]

    /// US-1249: stale-age is now whole CALENDAR days between the listed date and
    /// `now`, not `elapsed / 86_400`. The calendar is pinned to UTC on purpose —
    /// resolving the day delta in the device's local zone makes a window that
    /// crosses a DST fall-back compute one day short (the 25-hour day), which
    /// regresses the stale-age tests. UTC has no DST, so every day is exactly
    /// 86_400s and the count is both calendar-correct and deterministic.
    private static let staleAgeCalendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? cal.timeZone
        return cal
    }()

    /// Whole calendar days from `start` to `end` in the fixed UTC calendar.
    private static func wholeDaysBetween(_ start: Date, and end: Date) -> Int {
        staleAgeCalendar.dateComponents([.day], from: start, to: end).day ?? 0
    }

    /// Selects items that need pricing attention: no `target_price` set, OR a
    /// live listing first listed more than `staleDays` ago. Sorted so the most
    /// actionable rows lead — never-priced first, then stalest listings.
    static func candidates(
        items: [PriceSuggestionItemSnapshot],
        listings: [PriceSuggestionListingSnapshot],
        now: Date,
        staleDays: Int = 30
    ) -> [PriceSuggestionCandidate] {
        var listingsByItem: [String: [PriceSuggestionListingSnapshot]] = [:]
        for listing in listings {
            listingsByItem[listing.inventoryItemId, default: []].append(listing)
        }

        var out: [PriceSuggestionCandidate] = []
        for item in items {
            guard !terminalStatuses.contains(item.status) else { continue }
            let itemListings = listingsByItem[item.id] ?? []

            let activeListings = itemListings.filter { activeStatuses.contains($0.listingStatus) }
            let currentPrice = activeListings.map(\.listingPrice).max() ?? item.listingPrice
            let hasDraft = itemListings.contains { $0.listingStatus == "draft" }

            // Oldest active listing age, in whole calendar days (US-1249).
            let oldestListedAt = activeListings.compactMap(\.listedAt).min()
            let staleAge = oldestListedAt.map { Self.wholeDaysBetween($0, and: now) }
            let isStale = (staleAge ?? -1) > staleDays

            let reason: PriceSuggestionReason
            if item.targetPrice == nil {
                reason = .noTargetPrice
            } else if isStale, let age = staleAge {
                reason = .staleListing(days: age)
            } else {
                continue   // priced and fresh — nothing to suggest
            }

            out.append(PriceSuggestionCandidate(
                id: item.id,
                title: item.title.isEmpty ? "Untitled item" : item.title,
                brand: item.brand,
                size: item.size,
                currentPrice: currentPrice,
                hasDraft: hasDraft,
                reason: reason
            ))
        }

        return out.sorted { lhs, rhs in
            func rank(_ r: PriceSuggestionReason) -> Int {
                switch r {
                case .noTargetPrice: return 0
                case .staleListing: return 1
                }
            }
            let lr = rank(lhs.reason), rr = rank(rhs.reason)
            if lr != rr { return lr < rr }
            // Within stale, oldest first.
            if case let .staleListing(ld) = lhs.reason,
               case let .staleListing(rd) = rhs.reason, ld != rd {
                return ld > rd
            }
            return lhs.title < rhs.title
        }
    }
}
