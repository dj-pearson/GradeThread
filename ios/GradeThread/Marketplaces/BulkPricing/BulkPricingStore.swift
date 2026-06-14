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
    var priceText = ""
    var quantityText = ""
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
    }

    func toggleAll() {
        selected = selected.count == listings.count ? [] : Set(listings.map(\.id))
    }

    private var priceValue: Double? {
        let v = Double(priceText.trimmingCharacters(in: .whitespaces))
        guard let v, v > 0 else { return nil }
        return v
    }

    private var quantityValue: Int? {
        let s = quantityText.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty, let v = Int(s), v >= 0 else { return nil }
        return v
    }

    var priceActive: Bool { priceMode != .none && priceValue != nil }
    var quantityActive: Bool { quantityValue != nil }
    var canApply: Bool { !selected.isEmpty && (priceActive || quantityActive) && !busy }

    /// Target price for a row under the chosen mode (rounded to cents).
    private func targetPrice(_ row: BulkListing) -> Double? {
        guard let v = priceValue, priceMode != .none else { return nil }
        let raw = priceMode == .set ? v : row.price * (1 - v / 100)
        return (raw * 100).rounded() / 100
    }

    func apply() async {
        let qty = quantityValue
        var updates: [BulkPriceQtyUpdate] = []
        for row in listings where selected.contains(row.id) {
            let price = targetPrice(row)
            if price == nil && qty == nil { continue }
            updates.append(BulkPriceQtyUpdate(listingId: row.id, price: price, quantity: qty))
        }
        guard !updates.isEmpty else { return }

        busy = true
        defer { busy = false }
        do {
            let res = try await service.apply(updates: updates)
            let failed = res.results.filter { !$0.ok }
            rowErrors = Dictionary(uniqueKeysWithValues: failed.map { ($0.listingId, $0.error ?? "Failed") })
            if failed.isEmpty {
                actionBanner = "Updated \(res.succeeded) listing\(res.succeeded == 1 ? "" : "s")."
                selected = []
            } else {
                actionBanner = "Updated \(res.succeeded)/\(res.total). \(failed.count) failed."
            }
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}
