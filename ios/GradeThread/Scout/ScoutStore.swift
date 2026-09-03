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

    // ── US-3098: the deal filter ────────────────────────────────────────────
    //
    // Persisted in UserDefaults rather than held for the session. Sourcing is a
    // handful of searches run over and over — a seller who set "under $40, at
    // least 40%" on Saturday wants it still set on Sunday, and re-typing it in
    // a shop is how a filter stops getting used.
    //
    // Typed as TEXT, not numbers, because these are text fields: a half-typed
    // "4" while someone is reaching for "40" must not become a live filter, and
    // an Int binding cannot represent an empty field at all.
    @Published var maxTotalText = UserDefaults.standard.string(forKey: Keys.maxTotal) ?? "" {
        didSet { UserDefaults.standard.set(maxTotalText, forKey: Keys.maxTotal) }
    }
    @Published var minMarginPctText = UserDefaults.standard.string(forKey: Keys.minMarginPct) ?? "" {
        didSet { UserDefaults.standard.set(minMarginPctText, forKey: Keys.minMarginPct) }
    }
    @Published var minMarginDollarsText = UserDefaults.standard.string(forKey: Keys.minMargin) ?? "" {
        didSet { UserDefaults.standard.set(minMarginDollarsText, forKey: Keys.minMargin) }
    }
    @Published var buyItNowOnly = UserDefaults.standard.bool(forKey: Keys.buyItNowOnly) {
        didSet { UserDefaults.standard.set(buyItNowOnly, forKey: Keys.buyItNowOnly) }
    }
    @Published var freeShippingOnly = UserDefaults.standard.bool(forKey: Keys.freeShipping) {
        didSet { UserDefaults.standard.set(freeShippingOnly, forKey: Keys.freeShipping) }
    }
    @Published var browseSort: BrowseSort = BrowseSort(
        rawValue: UserDefaults.standard.string(forKey: Keys.browseSort) ?? ""
    ) ?? .bestMatch {
        didSet { UserDefaults.standard.set(browseSort.rawValue, forKey: Keys.browseSort) }
    }

    private enum Keys {
        static let maxTotal = "scout.filter.maxTotal"
        static let minMarginPct = "scout.filter.minMarginPct"
        static let minMargin = "scout.filter.minMargin"
        static let buyItNowOnly = "scout.filter.buyItNowOnly"
        static let freeShipping = "scout.filter.freeShipping"
        static let browseSort = "scout.filter.browseSort"
    }

    /// Which listings eBay shows us first. Distinct from ``SortKey``, which
    /// reorders the graded results already on screen: this one decides which
    /// fifty listings phase one ever looks at, and the two are easy to conflate.
    enum BrowseSort: String, CaseIterable, Identifiable {
        case bestMatch, newlyListed, endingSoonest, priceAsc
        var id: String { rawValue }
        var label: String {
            switch self {
            case .bestMatch:     return String(localized: "Best match")
            case .newlyListed:   return String(localized: "Newly listed")
            case .endingSoonest: return String(localized: "Ending soonest")
            case .priceAsc:      return String(localized: "Cheapest first")
            }
        }
    }

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
            var request = ScoutScanRequest(
                categoryId: categoryId,
                q: kw.isEmpty ? nil : kw,
                brand: br.isEmpty ? nil : br,
                limit: Self.scanLimit
            )
            request.maxTotalCents = Self.cents(from: maxTotalText)
            request.minMarginCents = Self.cents(from: minMarginDollarsText)
            // The field is typed in whole percent because that is how a seller
            // says it; the wire wants a fraction, and the route refuses 30.
            request.minMarginPct = Self.fraction(fromPercent: minMarginPctText)
            // "Buy It Now only" means no auctions. BEST_OFFER stays in: it is a
            // fixed-price listing whose price is negotiable, which is if
            // anything the better find, and dropping it would silently hide
            // half the results a seller ticking this box wants.
            request.buyingOptions = buyItNowOnly ? ["FIXED_PRICE", "BEST_OFFER"] : nil
            request.freeShippingOnly = freeShippingOnly ? true : nil
            request.sort = browseSort == .bestMatch ? nil : browseSort.rawValue
            response = try await service.scan(request)
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

    /// True when any filter is set, so Clear can be disabled rather than
    /// offered as a button that does nothing.
    var hasFilters: Bool {
        !maxTotalText.trimmed.isEmpty
            || !minMarginPctText.trimmed.isEmpty
            || !minMarginDollarsText.trimmed.isEmpty
            || buyItNowOnly
            || freeShippingOnly
            || browseSort != .bestMatch
    }

    /// Reset every filter, and the stored copy with it.
    func clearFilters() {
        maxTotalText = ""
        minMarginPctText = ""
        minMarginDollarsText = ""
        buyItNowOnly = false
        freeShippingOnly = false
        browseSort = .bestMatch
    }

    /// Dollars typed by a human to integer cents. Nil for blank or nonsense —
    /// a filter nobody set must not become a filter of zero.
    nonisolated static func cents(from text: String) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let value = Double(trimmed), value > 0 else { return nil }
        return Int((value * 100).rounded())
    }

    /// A whole-percent field to the fraction the route wants. 40 becomes 0.4.
    ///
    /// Anything above 100% is CLAMPED rather than refused: a seller who types
    /// 400 into "min return" means "only show me the real steals", and a 400
    /// that goes to the server as 4.0 comes back a 400 error naming a field
    /// they are looking straight at.
    nonisolated static func fraction(fromPercent text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let value = Double(trimmed), value > 0 else { return nil }
        return min(value / 100, 1)
    }

    /// "Looked at 42, graded 8" — or just the graded count on an older edge.
    var scanSummary: String? {
        guard let response else { return nil }
        guard let considered = response.considered else {
            return String(localized: "Scanned \(response.scanned) listings")
        }
        let graded = response.graded ?? response.scanned
        return String(localized: "Looked at \(considered) listings, graded \(graded)")
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
            // Scout works from a live eBay listing, which the app never resolves
            // to a leaf category — that happens at draft time. Sending a guess
            // would put a wrong category on the item for the composer to trust.
            categoryId: nil,
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
