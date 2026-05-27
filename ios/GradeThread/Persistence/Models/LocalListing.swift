import Foundation
import SwiftData

/// Local mirror of `listings`. Conflict policy treats server as the
/// source of truth for marketplace-owned fields (price, status, listed_at,
/// views) since eBay pushes those — see ``SyncEngine.merge(...)``.
@Model
final class LocalListing {
    @Attribute(.unique) var id: String
    var inventoryItemId: String

    var platform: String              // "ebay" | "poshmark" | …
    var platformListingId: String?
    var externalURL: String?

    var listingPrice: Double
    var listingStatus: String         // "draft" | "active" | "ended" | "sold" | "relisted"
    var listedAt: Date?
    var endedAt: Date?

    // Engagement metrics (US-151 — not actively populated yet)
    var viewsTotal: Int?
    var watchersCount: Int?

    var createdAt: Date
    var updatedAt: Date

    init(
        id: String,
        inventoryItemId: String,
        platform: String,
        listingPrice: Double,
        listingStatus: String,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.inventoryItemId = inventoryItemId
        self.platform = platform
        self.listingPrice = listingPrice
        self.listingStatus = listingStatus
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
