import Foundation
import SwiftData

/// Local mirror of `listings`. Conflict policy treats server as the
/// source of truth for marketplace-owned fields (price, status, listed_at,
/// views) since eBay pushes those — see ``SyncEngine.merge(...)``.
@Model
final class LocalListing {
    // US-985: `listingStatus` backs the active-listing count `#Predicate`
    // (EbaySyncService / SyncMergeActor), and `inventoryItemId` backs the
    // item→listing joins the dashboards do per render. `id` is covered by its
    // `@Attribute(.unique)` constraint.
    #Index<LocalListing>([\.listingStatus], [\.inventoryItemId])

    @Attribute(.unique) var id: String
    var inventoryItemId: String

    var platform: String              // "ebay" | "poshmark" | …
    var platformListingId: String?
    /// Sell Inventory API offer id. Non-nil ONLY for listings GradeThread
    /// published itself — that's what makes a listing revisable in place via the
    /// Sell API. eBay-native (pulled) listings have no offer, so they're edited
    /// on eBay instead. Drives the "Edit live listing" vs "Edit on eBay" branch.
    var platformOfferId: String?
    var externalURL: String?

    var listingPrice: Double
    var listingStatus: String         // "draft" | "active" | "ended" | "sold" | "relisted"
    var listedAt: Date?
    var endedAt: Date?

    // Engagement metrics (US-151 — not actively populated yet)
    var viewsTotal: Int?
    var watchersCount: Int?

    /// Provenance marker (US-1086): `"gradethread"` = published via FlipDesk/AutoLister
    /// (GradeThread owns the editable fields); `"ebay"` = imported from eBay (eBay is
    /// authoritative; editable fields are locked mirrors). Nil on older rows synced
    /// before the column was backfilled — fall back to `platformOfferId != nil` heuristic.
    var listingOrigin: String?

    /// US-1511: last outbound-push failure (publish/revise), mapped to a short
    /// user-facing message server-side (US-1079's `listings.publish_error`).
    /// Server-owned — the sync copies it verbatim; a successful push clears it.
    /// Nil = no recorded failure. Lets a scheduled/AutoLister publish failure
    /// surface on iOS (previously web-only, US-321 badge).
    var publishError: String?

    /// US-1249: marks a row carrying a pending local edit to a GradeThread-owned
    /// editable field (price/status) not yet pushed to the server. While set, the
    /// merge keeps the local value for those fields instead of clobbering it with
    /// the server copy — see ``SyncMergeActor/mergeListings(_:)`` +
    /// ``ConflictPolicy/resolveEbayOwnedListingField(local:server:hasLocalChanges:listingOrigin:)``.
    /// eBay-originated listings ignore it (eBay is always authoritative).
    var hasLocalChanges: Bool = false

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
