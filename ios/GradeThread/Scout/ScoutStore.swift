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
        } catch {
            response = nil
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Sorted + filtered candidates for the list. Pure passthrough to
    /// ``display(_:sortKey:actionableOnly:)`` so the ordering is unit-tested.
    var displayedCandidates: [ScoutCandidate] {
        Self.display(response?.candidates ?? [], sortKey: sortKey, actionableOnly: actionableOnly)
    }

    /// PURE: apply the "actionable only" filter then sort by the chosen key,
    /// descending. Missing values (nil margin / nil grade) sink to the bottom.
    static func display(
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
