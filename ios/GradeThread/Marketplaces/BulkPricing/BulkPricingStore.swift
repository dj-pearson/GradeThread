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
        var id: String { rawValue }
    }

    private let service: BulkPricingProviding

    var phase: Phase = .loading
    private(set) var listings: [BulkListing] = []
    var selected: Set<String> = []
    var priceMode: PriceMode = .none
    // US-1191: clear stale per-row failures when the user re-edits the inputs, so
    // a previous apply's error doesn't cling to a row being actively re-edited.
    var priceText = "" { didSet { if priceText != oldValue { rowErrors.removeAll() } } }
    var quantityText = "" { didSet { if quantityText != oldValue { rowErrors.removeAll() } } }
    var busy = false
    var actionError: String?
    var actionBanner: String?
    /// Per-listing failure messages from the last apply.
    private(set) var rowErrors: [String: String] = [:]

    init(service: BulkPricingProviding = BulkPricingService()) {
        self.service = service
    }

    func load() async {
        phase = .loading
        do {
            listings = try await service.listings()
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
        }
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
        let v = Double(priceText.trimmingCharacters(in: .whitespaces))
        guard let v else { return nil }
        switch priceMode {
        // US-1220: in `.reduce` mode the input is a PERCENT and must be strictly
        // between 0 and 100 — exactly 100 zeroes the price and >100 goes negative,
        // which the local `v > 0` check never caught (it validated the raw input,
        // not the computed result). `.set` keeps the generic positive-amount rule.
        case .reduce: return (v > 0 && v < 100) ? v : nil
        case .set: return v > 0 ? v : nil
        case .none: return nil
        }
    }

    private var quantityValue: Int? {
        let s = quantityText.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty, let v = Int(s), v >= 0 else { return nil }
        return v
    }

    var priceActive: Bool { priceMode != .none && priceValue != nil }
    var quantityActive: Bool { quantityValue != nil }
    var canApply: Bool { !selected.isEmpty && (priceActive || quantityActive) && !busy }

    /// US-1220: inline validation message for the price input (nil when valid or
    /// empty), so the user sees WHY a 100%+ reduction is blocked at the input
    /// instead of getting a generic per-row server "Failed".
    var priceInputError: String? {
        let trimmed = priceText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, priceMode != .none else { return nil }
        guard let v = Double(trimmed) else { return "Enter a valid number." }
        switch priceMode {
        case .reduce:
            if v <= 0 { return "Enter a reduction between 0% and 100%." }
            if v >= 100 { return "Reduction must be under 100% — a 100%+ cut would zero the price." }
            return nil
        case .set:
            if v <= 0 { return "Price must be greater than $0." }
            return nil
        case .none:
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
            let (price, priceError) = Self.validatedTargetPrice(
                base: row.price, mode: priceMode, percentOrAmount: pct
            )
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
