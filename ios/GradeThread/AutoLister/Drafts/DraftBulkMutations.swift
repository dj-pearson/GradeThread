import Foundation

/// Pure helpers for AutoLister bulk draft mutations (US-820): price math + the
/// field-change descriptor applied to an editable row. Dependency-free (only
/// ``Money``) so the bulk logic unit-tests without a store, the network, or a
/// SwiftUI context. Shared by the drafts-library multi-select bulk bar and the
/// per-batch bulk-edit grid so the two surfaces never drift.
enum DraftBulkMutation {

    /// How a bulk price edit changes each target draft's price.
    enum PriceChange: Equatable {
        /// Set every target to this absolute price.
        case absolute(Double)
        /// Adjust each target by a +/- percentage of its current price.
        case percent(Double)
        /// Floor + .99 (sub-$1 rounds to whole cents) — the reseller "charm price".
        case round99
    }

    /// One bulk field edit applied across the selected drafts.
    enum FieldChange: Equatable {
        case price(PriceChange)
        case condition(String)
        case template(ListingTemplate)
    }

    /// New cents-normalized price for `current` under `change`, or nil when the
    /// change can't apply (a percentage / round-to-.99 on a draft with no
    /// price). An absolute set always applies. Negative results floor at 0 so a
    /// bulk edit can never seed a sub-zero listing price.
    static func newPrice(for current: Double?, change: PriceChange) -> Double? {
        switch change {
        case .absolute(let price):
            return Money.cents(max(0, price))
        case .percent(let pct):
            guard let base = current else { return nil }
            return Money.cents(max(0, base * (1 + pct / 100)))
        case .round99:
            guard let base = current else { return nil }
            return Money.cents(roundTo99(base))
        }
    }

    /// Mirrors the web's roundTo99: sub-$1 rounds to whole cents; otherwise
    /// floor + .99.
    static func roundTo99(_ p: Double) -> Double {
        if p < 1 { return (p * 100).rounded() / 100 }
        return p.rounded(.down) + 0.99
    }

    /// Applies `change` to an editable row in place. A price change that can't
    /// apply (percent/round on a blank price) leaves the row untouched. A
    /// template only overwrites the fields it actually carries (US-674), so a
    /// preset that omits a policy never clears an existing one.
    static func apply(_ change: FieldChange, to row: inout DraftEditRow) {
        switch change {
        case .price(let pc):
            if let p = newPrice(for: Double(row.price), change: pc) {
                row.price = DraftEditRow.priceString(p)
            }
        case .condition(let condition):
            row.condition = condition
        case .template(let t):
            if let c = t.ebayCondition, !c.isEmpty { row.condition = c }
            if let cat = t.ebayCategoryId, !cat.isEmpty { row.categoryId = cat }
            if let p = t.returnPolicyId { row.returnPolicyId = p }
            if let p = t.shippingPolicyId { row.shippingPolicyId = p }
            if let p = t.paymentPolicyId { row.paymentPolicyId = p }
        }
    }
}
