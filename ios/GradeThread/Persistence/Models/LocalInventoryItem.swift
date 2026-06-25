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
    // US-985: cover the columns hit by #Predicate / sortBy so realtime upserts
    // and per-mutation lookups don't full-scan the catalog. `id` is already
    // indexed by its `@Attribute(.unique)` constraint, so it's intentionally
    // omitted here. `updatedAt` backs every list `@Query(sort:)`; `status` backs
    // the stage facets; the `gradeValue`/`(gradeValue, updatedAt)` pair backs the
    // Grades list (filter `gradeValue != nil`, sort by `updatedAt`).
    #Index<LocalInventoryItem>(
        [\.updatedAt], [\.status], [\.gradeValue], [\.gradeValue, \.updatedAt],
        // US-819: the dispute sync maps `disputes` rows (keyed by
        // grade_report_id) onto items by this column, so index it.
        [\.gradeReportId]
    )

    @Attribute(.unique) var id: String
    var userId: String

    var title: String
    var brand: String?
    var sku: String?
    var size: String?
    var color: String?
    var material: String?
    var status: String

    /// `inventory_items.item_category` enum value (e.g. "clothing", "shoes",
    /// "watches", "sports_cards"). Drives the per-category photo profile
    /// (PhotoProfileStore) for retag/capture. User-owned on sync (editable in
    /// the details form / canvas), same conflict policy as the other metadata.
    var itemCategory: String?

    /// Clothing classification (`inventory_items.garment_type` /
    /// `garment_category`). REQUIRED to grade a clothing item — the grading
    /// validate gate (flipdesk-grading.ts) blocks on a missing value. Only
    /// meaningful when `itemCategory == "clothing"`; user-owned on sync, edited
    /// in the canvas. Web parity (item-canvas.tsx garment pickers).
    var garmentType: String?
    var garmentCategory: String?

    /// Buyer-facing listing copy (`inventory_items.description`), the seller's
    /// style/variant note (`style`), and who sourced the item (`sourced_by`).
    /// All free-form, user-owned on sync (web parity — item-canvas.tsx). Named
    /// `itemDescription` to avoid shadowing `CustomStringConvertible.description`.
    var itemDescription: String?
    var style: String?
    var sourcedBy: String?

    /// Acquisition date (`inventory_items.acquired_date`) and storage/acquisition
    /// container label (`container`, distinct from `location_bin`). Both
    /// user-owned, web parity. Comp set (`comp_set` jsonb) is round-tripped as a
    /// raw JSON array string, same as `measurementsJSON`.
    var acquiredDate: Date?
    var container: String?
    var compSetJSON: String?

    /// `sources.id` this item was acquired from, when known. Powers the
    /// per-source ROI rollup (US-677). Optional — legacy/manual rows may have
    /// no source. Treated as a user-owned field on sync.
    var sourceId: String?

    /// Storage location / bin label (US-676), e.g. "Tote A3", "Rack 2".
    /// User-owned free-form text; powers the "filter by location" facet.
    var locationBin: String?

    /// `consignors.id` when this item is held on consignment (US-676), with an
    /// optional per-item split override (consignor's % of net proceeds). Both
    /// user-owned on sync.
    var consignorId: String?
    var consignmentSplitPct: Double?

    // Pricing
    var acquiredPrice: Double?
    var targetPrice: Double?
    var listingPrice: Double?  // most recent listed price, cached for the grid

    // Grade (filled when GradeThread completes — see grading-pipeline.ts step 7b)
    var gradeValue: Double?
    var gradeLabel: String?
    var certificateURL: String?

    /// US-819: linked `grade_reports.id` (server `inventory_items.grade_report_id`),
    /// when graded. Lets the dispute sync map a `disputes` row (keyed by
    /// grade_report_id) onto its item without an N+1 per-row fetch. Server-owned.
    var gradeReportId: String?

    /// US-819: latest dispute status for this item's grade report
    /// (`open`/`under_review`/`resolved`/`rejected`), or nil when undisputed.
    /// Stamped by ``SyncMergeActor/mergeDisputes(_:)`` from the synced `disputes`
    /// delta so the Grades list shows a per-row dispute badge with no per-row
    /// fetch. Server-owned.
    var disputeStatus: String?

    // Free-form fields the user owns. Conflict resolution treats these as
    // client-wins on sync — see SyncEngine.merge(...).
    var conditionNotes: String?
    var measurementsJSON: String?  // jsonb on the server; round-tripped as raw JSON

    // Photo summary (full photos live in LocalItemPhoto).
    /// Cached cover-photo URL for the grid thumbnail only — a render cache, not
    /// a presence signal. Photo *presence* derives from ``photos`` (US-994).
    var primaryPhotoURL: String?

    /// US-994: real relationship to this item's photos. Cascade delete so
    /// removing an item drops its photo rows instead of orphaning them. The
    /// inverse lives on ``LocalItemPhoto/item``; ``SyncMergeActor`` populates it
    /// on merge. Faults lazily, so the grid only pays for it when read.
    @Relationship(deleteRule: .cascade, inverse: \LocalItemPhoto.item)
    var photos: [LocalItemPhoto] = []

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

    /// US-994: photo presence from the relationship, not the denormalized
    /// `primaryPhotoURL` string (which drifts when the cover cache lags the
    /// actual photo set). Used by the grid "ready to list" cue and the
    /// with/missing-photo filter facet.
    var hasPhotos: Bool { !photos.isEmpty }

    /// US-1209: a grade has landed (`gradeValue` set) but it's a low-confidence
    /// result still awaiting human review, so it must NOT be presented as
    /// certified or shareable yet. We derive this from the absence of a
    /// `certificateURL`: the server only stamps a certificate once a grade
    /// certifies (high confidence) or a reviewer clears it, and the on-device
    /// optimistic stamp holds the certificate back below
    /// ``GradeScale/gradeReviewConfidenceThreshold`` too — so "graded but no
    /// certificate" is exactly the provisional / pending-review state.
    var isGradePendingReview: Bool {
        gradeValue != nil && (certificateURL?.isEmpty ?? true)
    }
}
