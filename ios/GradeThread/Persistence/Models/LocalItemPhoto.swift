import Foundation
import SwiftData

/// Local mirror of `item_photos`. One row per photo on disk.
@Model
final class LocalItemPhoto {
    // US-985: `inventoryItemId` backs the per-item photo `#Predicate`, and the
    // compound `(inventoryItemId, sortOrder)` backs the strip query that filters
    // by item and sorts by `sortOrder` (CertifiedGradeSection). `id` is covered
    // by its `@Attribute(.unique)` constraint.
    #Index<LocalItemPhoto>([\.inventoryItemId], [\.inventoryItemId, \.sortOrder])

    @Attribute(.unique) var id: String

    /// Loose wire FK to `inventory_items.id`. Retained for PostgREST mapping
    /// and the existing `@Query` predicates that filter photos by item id; the
    /// authoritative in-graph link is the ``item`` relationship below.
    var inventoryItemId: String

    /// US-994: inverse of ``LocalInventoryItem/photos``. The merge populates
    /// this so photo lookups fault lazily off the item and deleting an item
    /// cascade-deletes its photos (no orphaned rows). Optional because a photo
    /// row can briefly exist before its owning item lands in the cache.
    var item: LocalInventoryItem?

    var photoType: String     // server flipdesk_photo_type — see FlipdeskPhotoType.all
    var photoURL: String
    var thumbnailURL: String?
    var storagePath: String?

    var width: Int?
    var height: Int?
    var bytes: Int?
    var sortOrder: Int

    var createdAt: Date

    /// True when this photo was captured offline and not yet uploaded. The
    /// raw image bytes live in the file system under `photos/<id>.<ext>`;
    /// the upload mutation in PendingMutation refers to them by id.
    var localBytesPath: String?

    init(
        id: String,
        inventoryItemId: String,
        photoType: String,
        photoURL: String,
        sortOrder: Int = 0,
        createdAt: Date = .now,
        localBytesPath: String? = nil
    ) {
        self.id = id
        self.inventoryItemId = inventoryItemId
        self.photoType = photoType
        self.photoURL = photoURL
        self.sortOrder = sortOrder
        self.createdAt = createdAt
        self.localBytesPath = localBytesPath
    }
}
