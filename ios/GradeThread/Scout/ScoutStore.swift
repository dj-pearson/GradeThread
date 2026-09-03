import SwiftUI

/// View-model for ScoutAI (mirrors the web `FlipdeskScoutPage`). Holds the
/// search inputs + result, resolves a sharper eBay category from the query
/// (falling back to the broad apparel root), and exposes a pure
/// sorted/filtered view of the candidates for the list.
@MainActor
final class ScoutStore: ObservableObject {

    /// eBay "Clothing, Shoes & Accessories" — the broad apparel root used when
    /// the query doesn't resolve to a sharper leaf category. Same default the
    /// web page seeds.
    static let apparelRootId = "11450"
    static let apparelRootName = "Clothing, Shoes & Accessories"

    /// Candidates graded per scan — matches the edge `MAX_CANDIDATES` cap.
    static let scanLimit = 8

    enum SortKey: String, CaseIterable, Identifiable {
        case margin, grade, confidence
        var id: String { rawValue }
        var label: String {
            switch self {
            case .margin:     return "Margin"
            case .grade:      return "Shadow grade"
            case .confidence: return "Confidence"
            }
        }
    }

    @Published var keyword = ""
    @Published var brand = ""
    @Published var sortKey: SortKey = .margin
    @Published var actionableOnly = false

    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var response: ScoutScanResponse?
    /// The category the last scan actually used (nil = the apparel-root
    /// fallback), surfaced so the user can sanity-check the auto-resolution.
    @Published private(set) var resolvedCategory: CategorySuggestion?

    // US-3097: "Bought it" — the row action for the case Scout exists to
    // produce. Finding an underpriced listing and then having to retype it into
    // inventory by hand is where a deal finder stops being one.
    /// The candidate a buy is in flight for, so only that row spins.
    @Published private(set) var buyingItemId: String?
    /// Candidates already committed, by eBay item id → the inventory row id.
    /// Kept per scan so the row can disable itself and say "Added" instead of
    /// letting a second tap write a duplicate item.
    @Published private(set) var boughtItemIds: [String: String] = [:]
    /// The most recent buy failure, for the row to show inline.
    @Published private(set) var buyError: String?

    private let service: ScoutScanning

    init(service: ScoutScanning? = nil) {
        self.service = service ?? ScoutService()
    }

    var canSearch: Bool {
        !isLoading && !(keyword.trimmed.isEmpty && brand.trimmed.isEmpty)
    }

    /// Human label for the category a scan will/did use.
    var categoryLabel: String {
        resolvedCategory?.categoryName ?? Self.apparelRootName
    }

    func scan() async {
        guard canSearch else { return }
        let kw = keyword.trimmed
        let br = brand.trimmed

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        // Resolve a sharper category from the most descriptive term we have
        // (keyword first, else brand). A failed/empty resolution is non-fatal:
        // we fall back to the broad apparel root so the scan still runs.
        var categoryId = Self.apparelRootId
        let probe = kw.isEmpty ? br : kw
        let suggestion = try? await service.suggestCategory(for: probe)
        resolvedCategory = suggestion
        if let suggestion { categoryId = suggestion.categoryId }

        do {
            response = try await service.scan(
                categoryId: categoryId,
                q: kw.isEmpty ? nil : kw,
                brand: br.isEmpty ? nil : br,
                limit: Self.scanLimit
            )
            // US-701: announce the result so VoiceOver users know the scan
            // finished (the spinner silently swaps to the results list).
            let shown = displayedCandidates.count
            A11yAnnounce.announce(
                shown == 0
                    ? "Scan complete. No candidates found."
                    : "Scan complete. \(shown) \(shown == 1 ? "candidate" : "candidates") found.")
        } catch {
            response = nil
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            A11yAnnounce.announce("Scan failed. \(errorMessage ?? "")")
        }
    }

    /// Commit a candidate into inventory at `sourced`, priced at what the
    /// seller is about to pay for it.
    ///
    /// The asking price IS the cost basis: it is what the flipper hands over.
    /// The estimated value median becomes the target price, so the item lands
    /// with the number Scout just worked out rather than a blank the seller
    /// re-derives later.
    func buy(_ candidate: ScoutCandidate) async {
        guard buyingItemId == nil, boughtItemIds[candidate.itemId] == nil else { return }
        buyingItemId = candidate.itemId
        buyError = nil
        defer { buyingItemId = nil }

        let request = ProspectBuyRequest(
            title: candidate.title,
            brand: nil,
            size: nil,
            color: nil,
            costCents: candidate.askingCents,
            targetCents: candidate.valueMedianCents,
            gradeValue: candidate.shadowGrade,
            gradeLabel: nil,
            // The shadow grade is PRIVATE to this tenant (US-620) and is never
            // written to grade_reports. Carrying the reason as a condition note
            // keeps why-we-bought-it with the item without publishing a grade.
            conditionNotes: candidate.reason
        )

        do {
            let response = try await service.buy(request)
            boughtItemIds[candidate.itemId] = response.id
            A11yAnnounce.announce("Added to inventory.")
        } catch {
            buyError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            A11yAnnounce.announce("Could not add to inventory. \(buyError ?? "")")
        }
    }

    /// Sorted + filtered candidates for the list. Pure passthrough to
    /// ``display(_:sortKey:actionableOnly:)`` so the ordering is unit-tested.
    var displayedCandidates: [ScoutCandidate] {
        Self.display(response?.candidates ?? [], sortKey: sortKey, actionableOnly: actionableOnly)
    }

    /// PURE: apply the "actionable only" filter then sort by the chosen key,
    /// descending. Missing values (nil margin / nil grade) sink to the bottom.
    nonisolated static func display(
        _ candidates: [ScoutCandidate],
        sortKey: SortKey,
        actionableOnly: Bool
    ) -> [ScoutCandidate] {
        var list = candidates
        if actionableOnly { list = list.filter(\.actionable) }
        return list.sorted { a, b in
            switch sortKey {
            case .margin:
                return (a.estMarginCents ?? .min) > (b.estMarginCents ?? .min)
            case .grade:
                return (a.shadowGrade ?? -.greatestFiniteMagnitude) > (b.shadowGrade ?? -.greatestFiniteMagnitude)
            case .confidence:
                return a.gradeConfidence > b.gradeConfidence
            }
        }
    }
}

extension String {
    /// Whitespace-trimmed copy. Kept here (internal) for the Scout inputs;
    /// distinct from the optional-returning `facetTrimmed`.
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
