import Foundation
import Observation

/// US-3106 — what buyers are actually asking for, on the phone.
///
/// `GET /api/flipdesk/demand` aggregates every PUBLIC active buyer want into a
/// PII-safe signal: per brand and per category, how many people want it and the
/// strongest budget any of them named. The web has shown it since US-1831. The
/// phone — the device a seller is holding in the aisle, deciding what to pick
/// up — showed nothing.
///
/// **Global, not tenant-scoped.** Every signed-in seller sees the same market
/// demand, which is why nothing here filters by workspace: the aggregation IS
/// the privacy boundary, and no buyer identity crosses it.
struct DemandFacet: Decodable, Equatable, Identifiable, Sendable {
    let term: String
    let wantCount: Int
    /// The highest minimum grade any want in this facet asked for. A quality
    /// signal: buyers wanting 9s are not buyers wanting anything wearable.
    let topMinGrade: Double?
    /// The highest ceiling any want here named, in cents.
    let topMaxPriceCents: Int?

    var id: String { term }

    init(
        term: String = "",
        wantCount: Int = 0,
        topMinGrade: Double? = nil,
        topMaxPriceCents: Int? = nil
    ) {
        self.term = term
        self.wantCount = wantCount
        self.topMinGrade = topMinGrade
        self.topMaxPriceCents = topMaxPriceCents
    }
}

struct DemandAggregate: Decodable, Equatable, Sendable {
    let brands: [DemandFacet]
    let categories: [DemandFacet]
    let totalWants: Int

    init(brands: [DemandFacet] = [], categories: [DemandFacet] = [], totalWants: Int = 0) {
        self.brands = brands
        self.categories = categories
        self.totalWants = totalWants
    }

    /// The strip's chips: the most-wanted facets across both lists.
    ///
    /// Brands and categories are RANKED TOGETHER rather than shown as two rows.
    /// A seller holding a garment does not think "is this a brand question or a
    /// category question" — they want the few words worth searching, and eight
    /// chips is the most a phone shows before the strip becomes a list nobody
    /// reads to the end of.
    ///
    /// A brand wins a tie with a category of the same size: it is the narrower
    /// search, and a narrow search that returns something beats a broad one that
    /// returns everything.
    func topFacets(limit: Int = 8) -> [DemandFacet] {
        var seen = Set<String>()
        let ranked = (brands + categories)
            .filter { !$0.term.trimmingCharacters(in: .whitespaces).isEmpty && $0.wantCount > 0 }
            .enumerated()
            .sorted { lhs, rhs in
                if lhs.element.wantCount != rhs.element.wantCount {
                    return lhs.element.wantCount > rhs.element.wantCount
                }
                // Stable: brands come first in the concatenation, so the
                // original index breaks the tie the way the comment above says.
                return lhs.offset < rhs.offset
            }
            .map(\.element)

        var out: [DemandFacet] = []
        for facet in ranked {
            let key = facet.term.lowercased()
            // A term that is both a brand and a category is one chip, not two.
            guard seen.insert(key).inserted else { continue }
            out.append(facet)
            if out.count == limit { break }
        }
        return out
    }
}

/// Reads the demand aggregate. Injectable so the strip is testable with no
/// network.
@MainActor
protocol DemandReading {
    func demand() async throws -> DemandAggregate
}

@MainActor
final class DemandService: DemandReading {
    init() {}

    func demand() async throws -> DemandAggregate {
        try await EdgeAPI.shared.getJSON("/api/flipdesk/demand", query: [])
    }
}

/// The strip's state.
///
/// Failure is SILENT and leaves the strip hidden. This is a hint on an empty
/// state, not a step: a seller standing in a shop with no signal must see the
/// scan button, not an error about a market summary they did not ask for. The
/// plan gate is the same — `compPulls` gates this route exactly as it gates the
/// scan below it, and a seller without it gets no strip rather than a second
/// upgrade prompt on a screen that already has one.
@MainActor
@Observable
final class DemandStrip {

    private(set) var facets: [DemandFacet] = []
    private(set) var isLoading = false
    private(set) var didLoad = false

    private let service: DemandReading

    init(service: DemandReading? = nil) {
        self.service = service ?? DemandService()
    }

    var isVisible: Bool { !facets.isEmpty }

    /// Load once per screen. A seller who takes four photos should not spend
    /// four requests on a market summary that changes by the day.
    func loadIfNeeded() async {
        guard !didLoad, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        didLoad = true
        do {
            facets = try await service.demand().topFacets()
        } catch {
            facets = []
        }
    }
}
