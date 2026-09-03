import Foundation
import SwiftData

/// US-3100 — the sourcing log a reseller currently keeps in Notes.
///
/// Prospect answered "is this worth buying" and then threw the answer away the
/// moment the sheet closed. A seller working a rack scans six garments in ten
/// minutes, buys two, and walks out. An hour later they cannot remember which
/// of the four they passed on was the close call, and there is nothing to go
/// back to — so they either re-scan it (a second AI action for an answer they
/// already had) or they lose it.
///
/// **LOCAL ONLY, and deliberately so.** This is not a synced mirror like
/// `LocalInventoryItem`: there is no server table behind it and none is wanted.
/// A prospect is a thought about a garment somebody else owns. Syncing it would
/// mean storing every seller's shopping consideration on our servers, which is
/// a privacy cost with no product behind it — the thing worth keeping is the
/// item they actually bought, and that already becomes an inventory row.
///
/// **Tenant-scoped anyway.** `userId` is carried and the row is wiped on
/// sign-out and on a workspace switch, exactly like the synced models, because
/// a shared iPad handing the next person a list of what the last one was
/// considering is the same leak whether or not a server was involved
/// (US-2496).
@Model
final class LocalProspectResult {
    // Newest-first is the only order this is ever read in.
    #Index<LocalProspectResult>([\.createdAt], [\.userId])

    @Attribute(.unique) var id: String
    var userId: String

    /// What the scan decided it was. Nil when nothing was identified — the row
    /// is still worth keeping, because "we could not tell" is an answer a
    /// seller acts on too.
    var title: String?
    var brand: String?
    var categoryId: String?
    var categoryPath: String?

    var gradeValue: Double?
    var gradeTier: String?

    var medianCents: Int?
    var lowCents: Int?
    var highCents: Int?
    /// "buy" | "maybe" | "skip", or nil when no cost was entered.
    var decision: String?
    /// The most to pay for the seller's target return, when the server had one.
    var ceilingCents: Int?
    /// What the seller said they would pay, if anything.
    var costCents: Int?

    /// The garment photo, as JPEG bytes.
    ///
    /// Stored with `.externalStorage`, so SwiftData writes anything sizeable to
    /// a file rather than inlining it in the store — twenty full-frame photos
    /// inlined would bloat every query against this table for the sake of a
    /// 44pt thumbnail. Downscaled before it gets here; see `ProspectLog`.
    @Attribute(.externalStorage) var thumbnailData: Data?

    /// Set once the seller commits this to inventory, so the row can say
    /// "Added" rather than offering to add it twice.
    var addedItemId: String?

    var createdAt: Date

    init(
        id: String = UUID().uuidString,
        userId: String,
        title: String? = nil,
        brand: String? = nil,
        categoryId: String? = nil,
        categoryPath: String? = nil,
        gradeValue: Double? = nil,
        gradeTier: String? = nil,
        medianCents: Int? = nil,
        lowCents: Int? = nil,
        highCents: Int? = nil,
        decision: String? = nil,
        ceilingCents: Int? = nil,
        costCents: Int? = nil,
        thumbnailData: Data? = nil,
        addedItemId: String? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.userId = userId
        self.title = title
        self.brand = brand
        self.categoryId = categoryId
        self.categoryPath = categoryPath
        self.gradeValue = gradeValue
        self.gradeTier = gradeTier
        self.medianCents = medianCents
        self.lowCents = lowCents
        self.highCents = highCents
        self.decision = decision
        self.ceilingCents = ceilingCents
        self.costCents = costCents
        self.thumbnailData = thumbnailData
        self.addedItemId = addedItemId
        self.createdAt = createdAt
    }

    /// What the row calls itself. Falls back through what was identified rather
    /// than showing an id nobody recognises.
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let brand, !brand.isEmpty { return brand }
        return String(localized: "Unidentified item")
    }
}
