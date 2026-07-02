import Foundation
import Observation

/// Drives the bulk price/quantity editor (US-1046 clean surface).
@MainActor
@Observable
final class BulkPricingStore {
    enum Phase: Equatable { case loading, ready, failed(String) }
    enum PriceMode: String, CaseIterable, Identifiable {
        case none = "No change"
        case set = "Set price"
        case reduce = "Reduce %"
        // US-1167 (AC2): per-row suggested price pulled from each listing's active
        // eBay comps (median asking price) instead of one global value.
        case suggestFromComps = "From comps"
        var id: String { rawValue }
    }

    private let service: BulkPricingProviding
    /// US-1167 (AC2): two-hop comps lookup for the "From comps" mode. Same
    /// source the ItemCanvas comps panel / publish composer use.
    private let comps: CompsProviding

    var phase: Phase = .loading
    private(set) var listings: [BulkListing] = []
    var selected: Set<String> = []
    var priceMode: PriceMode = .none {
        // US-1167 (AC2): switching modes drops stale comp suggestions and any
        // per-row failure so the previous mode's state can't leak into the next.
        didSet {
            if priceMode != oldValue {
                suggestedPrices.removeAll()
                rowErrors.removeAll()
            }
        }
    }
    // US-1191: clear stale per-row failures when the user re-edits the inputs, so
    // a previous apply's error doesn't cling to a row being actively re-edited.
    var priceText = "" { didSet { if priceText != oldValue { rowErrors.removeAll() } } }
    var quantityText = "" { didSet { if quantityText != oldValue { rowErrors.removeAll() } } }
    var busy = false
    var actionError: String?
    var actionBanner: String?
    /// Per-listing failure messages from the last apply.
    private(set) var rowErrors: [String: String] = [:]

    /// US-1167 (AC2): comp-derived suggested price per listing id, populated by
    /// ``suggestFromComps()``. Drives both the row preview and the apply payload
    /// when ``priceMode`` is `.suggestFromComps`.
    private(set) var suggestedPrices: [String: Double] = [:]
    /// US-1167 (AC2): comp-fetch progress for the "From comps" mode (N listings ×
    /// 2 network hops each), so a multi-row fetch shows live progress, not a
    /// frozen button.
    private(set) var fetchingComps = false
    private(set) var compsDone = 0
    private(set) var compsTotal = 0

    /// US-1216: bulk edits all route through the user's PRIMARY eBay store on the
    /// edge, and `listings` carries no per-store column, so when more than one
    /// store is connected we name the target store in the UI rather than letting
    /// the user unknowingly push secondary-store prices through the primary token.
    private(set) var hasMultipleAccounts = false
    private(set) var primaryAccountName: String?

    // `comps` defaults to nil (not `CompsService()`): a default argument is
    // evaluated in the caller's isolation, and CompsService's init is
    // @MainActor — so it's constructed inside this MainActor init body instead.
    init(service: BulkPricingProviding = BulkPricingService(), comps: CompsProviding? = nil) {
        self.service = service
        self.comps = comps ?? CompsService()
    }

    func load() async {
        phase = .loading
        do {
            listings = try await service.listings()
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
            return
        }
        await loadAccountContext()
    }

    /// US-1216: resolve which eBay store bulk edits target. Best-effort — a
    /// failure here must never block the listings the user came to edit, so it
    /// just leaves the banner hidden.
    private func loadAccountContext() async {
        guard let accounts = try? await service.ebayAccounts() else { return }
        hasMultipleAccounts = accounts.count > 1
        primaryAccountName = (accounts.first(where: \.isPrimary) ?? accounts.first)?.displayName
    }

    func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
        rowErrors[id] = nil  // US-1191: drop a stale failure on the toggled row
    }

    func toggleAll() {
        selected = selected.count == listings.count ? [] : Set(listings.map(\.id))
        rowErrors.removeAll()  // US-1191
    }

    /// US-1220: smallest price the eBay edge accepts; a computed price below this
    /// is rejected client-side with a row reason instead of an opaque server fail.
    static let minPrice = 0.01

    private var priceValue: Double? {
        // US-1491: locale-aware parse so "12,5" (percent or price) reads correctly
        // in comma-decimal locales instead of failing to nil / dropping the fraction.
        let v = CurrencyFormatter().parse(priceText)
        guard let v else { return nil }
        switch priceMode {
        // US-1220: in `.reduce` mode the input is a PERCENT and must be strictly
        // between 0 and 100 — exactly 100 zeroes the price and >100 goes negative,
        // which the local `v > 0` check never caught (it validated the raw input,
        // not the computed result). `.set` keeps the generic positive-amount rule.
        case .reduce: return (v > 0 && v < 100) ? v : nil
        case .set: return v > 0 ? v : nil
        // `.suggestFromComps` has no single global input — prices are per-row.
        case .none, .suggestFromComps: return nil
        }
    }

    private var quantityValue: Int? {
        let s = quantityText.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty, let v = Int(s), v >= 0 else { return nil }
        return v
    }

    var priceActive: Bool {
        switch priceMode {
        case .none: return false
        case .set, .reduce: return priceValue != nil
        // US-1167 (AC2): active once at least one selected row has a comp-derived
        // suggested price to apply.
        case .suggestFromComps: return selected.contains { suggestedPrices[$0] != nil }
        }
    }
    var quantityActive: Bool { quantityValue != nil }
    var canApply: Bool { !selected.isEmpty && (priceActive || quantityActive) && !busy }

    /// US-1220: inline validation message for the price input (nil when valid or
    /// empty), so the user sees WHY a 100%+ reduction is blocked at the input
    /// instead of getting a generic per-row server "Failed".
    var priceInputError: String? {
        let trimmed = priceText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, priceMode != .none else { return nil }
        // US-1491: locale-aware parse (matches priceValue) so a valid comma-decimal
        // entry isn't rejected as "not a number".
        guard let v = CurrencyFormatter().parse(trimmed) else { return "Enter a valid number." }
        switch priceMode {
        case .reduce:
            if v <= 0 { return "Enter a reduction between 0% and 100%." }
            if v >= 100 { return "Reduction must be under 100% — a 100%+ cut would zero the price." }
            return nil
        case .set:
            if v <= 0 { return "Price must be greater than $0." }
            return nil
        case .none, .suggestFromComps:
            return nil
        }
    }

    /// Target price for a row under the chosen mode (rounded to cents).
    private func targetPrice(_ row: BulkListing) -> Double? {
        guard let v = priceValue, priceMode != .none else { return nil }
        let raw = priceMode == .set ? v : row.price * (1 - v / 100)
        return (raw * 100).rounded() / 100
    }

    /// US-1220: the computed target price for a row, plus a client-side reason
    /// when it is below `minPrice` (e.g. a deep reduce on a cheap item rounds to
    /// $0.00). `nil` reason means the price is valid (or there is no price edit).
    /// Pure + nonisolated for unit testing the reduce-mode bounds.
    nonisolated static func validatedTargetPrice(
        base: Double, mode: PriceMode, percentOrAmount: Double?
    ) -> (price: Double?, error: String?) {
        guard let v = percentOrAmount, mode != .none else { return (nil, nil) }
        let raw = mode == .set ? v : base * (1 - v / 100)
        let rounded = (raw * 100).rounded() / 100
        if rounded < minPrice {
            return (nil, rounded <= 0
                ? "Reduced price would be $0 or less — lower the reduction."
                : "Reduced price would be below $0.01 — lower the reduction.")
        }
        return (rounded, nil)
    }

    // MARK: - US-1167 (AC2): suggest from comps

    /// Comp-derived suggested price: the median of ACTIVE eBay asking prices for
    /// the listing's title. AC3 — these are active asks, not sold prices, so the
    /// UI labels them as a competitive starting point, not a guaranteed sale
    /// price. Pure + nonisolated so the median→price mapping is unit-testable.
    nonisolated static func suggestedPrice(from stats: CompStats) -> Double? {
        guard stats.count > 0, let median = stats.median, median > 0 else { return nil }
        return (median * 100).rounded() / 100
    }

    /// The comp-derived suggested price for a row, when one was fetched.
    func suggestedPrice(for id: String) -> Double? { suggestedPrices[id] }

    /// US-1167 (AC2): fetch active eBay comps for every selected listing (by
    /// title) and pre-fill a per-row suggested price = the comp median. Each
    /// listing is two network hops (category-suggest + comps), so progress is
    /// surfaced live. A miss (no category / no comps) is recorded as a row note;
    /// a successful suggestion clears any prior note on that row.
    func suggestFromComps() async {
        guard priceMode == .suggestFromComps, !selected.isEmpty, !fetchingComps else { return }
        let targets = listings.filter { selected.contains($0.id) }
        guard !targets.isEmpty else { return }

        fetchingComps = true
        compsTotal = targets.count
        compsDone = 0
        var found: [String: Double] = [:]
        var misses: [String: String] = [:]
        defer { fetchingComps = false }

        for row in targets {
            do {
                if let lookup = try await comps.lookup(title: row.title, brand: nil, size: nil),
                   let price = Self.suggestedPrice(from: lookup.stats) {
                    found[row.id] = price
                } else {
                    misses[row.id] = "No active eBay comps found."
                }
            } catch {
                misses[row.id] = "Couldn't fetch comps — try again."
            }
            compsDone += 1
        }

        suggestedPrices = found
        rowErrors = misses
        actionBanner = found.isEmpty
            ? "No comp suggestions found for the selected listing\(targets.count == 1 ? "" : "s")."
            : "Suggested prices for \(found.count) of \(targets.count) listing\(targets.count == 1 ? "" : "s")."
    }

    func apply() async {
        let qty = quantityValue
        let pct = priceValue
        var updates: [BulkPriceQtyUpdate] = []
        // US-1220: client-side reasons for rows whose COMPUTED price floors out
        // (e.g. a 99% reduce on a $0.50 item rounds below $0.01). Surfaced as a
        // row failure with a real explanation instead of letting the edge bounce
        // it with an opaque "Failed".
        var preflight: [String: String] = [:]
        for row in listings where selected.contains(row.id) {
            let price: Double?
            let priceError: String?
            if priceMode == .suggestFromComps {
                // US-1167 (AC2): the per-row comp suggestion is an absolute price,
                // so it floors through the same `.set` validation. A row with no
                // suggestion keeps any quantity edit but can't set a price.
                if let suggested = suggestedPrices[row.id] {
                    (price, priceError) = Self.validatedTargetPrice(
                        base: row.price, mode: .set, percentOrAmount: suggested
                    )
                } else {
                    (price, priceError) = (nil, qty == nil
                        ? "No comp suggestion — fetch comps or pick another price mode."
                        : nil)
                }
            } else {
                (price, priceError) = Self.validatedTargetPrice(
                    base: row.price, mode: priceMode, percentOrAmount: pct
                )
            }
            if let priceError {
                preflight[row.id] = priceError
                continue
            }
            if price == nil && qty == nil { continue }
            updates.append(BulkPriceQtyUpdate(listingId: row.id, price: price, quantity: qty))
        }

        guard !updates.isEmpty else {
            // Everything selected was filtered out by the price floor — show why.
            if !preflight.isEmpty {
                rowErrors = preflight
                actionBanner = "Nothing applied — \(preflight.count) row\(preflight.count == 1 ? "" : "s") need a smaller reduction."
            }
            return
        }

        busy = true
        defer { busy = false }
        do {
            let res = try await service.apply(updates: updates)
            let failed = res.results.filter { !$0.ok }
            var merged = Dictionary(uniqueKeysWithValues: failed.map { ($0.listingId, $0.error ?? "Failed") })
            for (id, reason) in preflight { merged[id] = reason }
            rowErrors = merged
            let problems = failed.count + preflight.count
            if problems == 0 {
                actionBanner = "Updated \(res.succeeded) listing\(res.succeeded == 1 ? "" : "s")."
                selected = []
            } else {
                actionBanner = "Updated \(res.succeeded)/\(res.total + preflight.count). \(problems) failed."
            }
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}
