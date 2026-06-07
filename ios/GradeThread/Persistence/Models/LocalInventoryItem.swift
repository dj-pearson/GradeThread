import Foundation
import SwiftData

/// Local-cache mirror of Supabase's `inventory_items` / `items_full` row.
///
/// SwiftData class types so we get @Model storage + change-tracking, but
/// the fields map 1:1 with the wire row from PostgREST. Conversion from
/// the wire DTO (``RemoteInventoryItem``) into a stored row happens in
/// ``SyncEngine`` with the conflict policy applied.
///
/// The `id` is unique because it's the Supabase UUID; SwiftData enforces
/// the uniqueness via `@Attribute(.unique)`.
@Model
final class LocalInventoryItem {
    @Attribute(.unique) var id: String
    var userId: String

    var title: String
    var brand: String?
    var sku: String?
    var size: String?
    var color: String?
    var material: String?
    var status: String

    /// `sources.id` this item was acquired from, when known. Powers the
    /// per-source ROI rollup (US-677). Optional — legacy/manual rows may have
    /// no source. Treated as a user-owned field on sync.
    var sourceId: String?

    // Pricing
    var acquiredPrice: Double?
    var targetPrice: Double?
    var listingPrice: Double?  // most recent listed price, cached for the grid

    // Grade (filled when GradeThread completes — see grading-pipeline.ts step 7b)
    var gradeValue: Double?
    var gradeLabel: String?
    var certificateURL: String?

    // Free-form fields the user owns. Conflict resolution treats these as
    // client-wins on sync — see SyncEngine.merge(...).
    var conditionNotes: String?
    var measurementsJSON: String?  // jsonb on the server; round-tripped as raw JSON

    // Photo summary (full photos live in LocalItemPhoto).
    var primaryPhotoURL: String?

    // Timestamps
    var createdAt: Date
    var updatedAt: Date

    // Local-only tracking
    /// Marks rows that originated locally and haven't yet been pushed to
    /// the server (intake created while offline). Cleared once
    /// `SyncEngine.flushPending()` confirms the insert.
    var hasLocalChanges: Bool

    init(
        id: String,
        userId: String,
        title: String,
        status: String = "cataloged",
        createdAt: Date = .now,
        updatedAt: Date = .now,
        hasLocalChanges: Bool = false
    ) {
        self.id = id
        self.userId = userId
        self.title = title
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.hasLocalChanges = hasLocalChanges
    }
}
