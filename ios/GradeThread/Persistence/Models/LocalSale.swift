import Foundation
import GradeThreadCore
import SwiftData

/// Local mirror of `sales`. Same conflict policy as LocalListing: the
/// marketplace-owned fields (sale_price, fees, payout_reference) are
/// server-authoritative.
@Model
final class LocalSale {
    // US-985: `saleDate` backs the Money/Sales list `@Query(sort:)`, `createdAt`
    // backs the background-refresh sort, and `inventoryItemId` backs the
    // sale→item joins. `id` is covered by its `@Attribute(.unique)` constraint.
    #Index<LocalSale>([\.saleDate], [\.createdAt], [\.inventoryItemId])

    @Attribute(.unique) var id: String
    var inventoryItemId: String
    var listingId: String?

    var salePrice: Double
    var platformFees: Double
    var paymentProcessingFees: Double?
    var shippingCollected: Double?
    var shippingCost: Double?
    var gradingCost: Double?
    var otherCosts: Double?
    var tax: Double?
    var netProfit: Double?

    /// Sale lifecycle (00111). Only "completed" counts toward revenue/profit/
    /// sold totals; "cancelled"/"refunded" are excluded. Defaults to
    /// "completed" so legacy rows behave as before until the next sync stamps
    /// the real status.
    var status: String = "completed"

    var buyerUsername: String?
    var platformOrderId: String?
    var payoutReference: String?

    var saleDate: Date
    var soldAt: Date?
    var shippedAt: Date?
    var trackingNumber: String?

    /// US-1249: marks a sale row with a pending local edit to a user-editable
    /// bookkeeping field (label/grading/other costs) not yet pushed. While set,
    /// the merge keeps those local values instead of overwriting them with the
    /// server copy — see ``SyncMergeActor/mergeSales(_:)``. Server-owned money
    /// fields (sale_price, fees, shipping_collected, tax) always refresh.
    var hasLocalChanges: Bool = false

    var createdAt: Date

    init(
        id: String,
        inventoryItemId: String,
        salePrice: Double,
        saleDate: Date,
        platformFees: Double = 0,
        createdAt: Date = .now
    ) {
        self.id = id
        self.inventoryItemId = inventoryItemId
        self.salePrice = salePrice
        self.saleDate = saleDate
        self.platformFees = platformFees
        self.createdAt = createdAt
    }
}

// SalePnL (in GradeThreadCore) computes per-sale P&L against this protocol so the
// money math is Linux-testable. LocalSale's stored properties already match it,
// so the conformance is empty. Not `@retroactive` — LocalSale is defined here.
extension LocalSale: SaleFinancials {}
