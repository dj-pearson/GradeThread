import Foundation

/// The pure half of recording a sale: the numbers, what they add up to, and
/// what stops the save. No network, no SwiftUI, so every rule here is unit
/// tested rather than clicked through.
///
/// Mirrors the web `RecordSaleDialog` field for field, because both write the
/// same `sales` row and the same reconciliation reads it back.
struct RecordSaleForm: Equatable {
    var salePrice = ""
    var shippingCollected = ""
    var platformFees = ""
    var paymentProcessingFees = ""
    var shippingCost = ""
    var tax = ""
    var otherCosts = ""
    var buyerUsername = ""
    var saleDate = Date()

    /// What the seller keeps: everything collected, minus every fee and cost,
    /// minus what the item cost to buy. Shown live while typing, and stored on
    /// the row so a later report does not have to re-derive it.
    func netProfit(purchasePrice: Double, parse: (String) -> Double?) -> Double {
        func n(_ s: String) -> Double { parse(s) ?? 0 }
        return n(salePrice) + n(shippingCollected)
            - n(platformFees) - n(paymentProcessingFees)
            - n(shippingCost) - n(tax) - n(otherCosts)
            - purchasePrice
    }

    /// Why the save is refused, or nil when it is allowed.
    ///
    /// Both rules exist because the numbers outlive the moment. A zero price
    /// records a sale that pays nothing, and a negative fee INFLATES net profit
    /// rather than reducing it -- neither is visible again until the month's
    /// figures are wrong and nothing says why.
    func validationError(parse: (String) -> Double?) -> String? {
        guard let price = parse(salePrice), price > 0 else {
            return "Enter a sale price greater than 0."
        }
        let costs = [
            shippingCollected, platformFees, paymentProcessingFees,
            shippingCost, tax, otherCosts,
        ]
        if costs.contains(where: { (parse($0) ?? 0) < 0 }) {
            return "Fees and costs can't be negative."
        }
        return nil
    }
}

/// Statuses a SALE owns.
///
/// Reaching one of these means a `sales` row exists behind it: recording the
/// sale is what makes an item sold, and picking the word from a dropdown is
/// not. A bare status write leaves sold totals, profit and reconciliation
/// disagreeing with inventory, with nothing anywhere to surface the gap.
///
/// Matches the web `SALE_OWNED_STATUSES` exactly. Deliberately NOT
/// ``StatusGuard/terminalStates``, which also holds "archived" -- archiving an
/// item is a shelving decision the seller may make by hand, and no money moves.
enum SaleOwnedStatus {
    static let all: Set<String> = ["sold", "shipped", "completed", "returned"]

    static func owns(_ status: String) -> Bool {
        all.contains(status.trimmingCharacters(in: .whitespaces).lowercased())
    }

    /// The statuses the item page's picker may offer.
    ///
    /// The item's CURRENT status stays listed even when a sale owns it, or an
    /// already-sold item's picker would render showing something it is not.
    static func selectable(from statuses: [String], current: String) -> [String] {
        statuses.filter { $0 == current || !owns($0) }
    }
}
