import Foundation
import SwiftData

/// Local mirror of `sales`. Same conflict policy as LocalListing: the
/// marketplace-owned fields (sale_price, fees, payout_reference) are
/// server-authoritative.
@Model
final class LocalSale {
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
