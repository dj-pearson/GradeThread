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

    /// US-2468 (migration 00587): the open-text qualifier saying what the photo
    /// actually shows — 'fabric' on a detail, 'size' on a tag, 'inseam' on a
    /// measurement. nil means no qualifier.
    ///
    /// Optional WITH a default so SwiftData can migrate the existing store
    /// lightweight: a non-optional addition needs a mapping model, and a store
    /// that fails to open takes the app down at launch rather than at the
    /// feature (see the duplicate-checksum trap in the iOS traps note).
    var photoRole: String?
    var photoURL: String
    var thumbnailURL: String?
    var storagePath: String?

    var width: Int?
    var height: Int?
    var bytes: Int?
    var sortOrder: Int

    /// Local-only cache-buster, bumped whenever the bytes at ``storagePath`` are
    /// rewritten in place (rotate). Private-bucket photos (tag/tag_2/certificate)
    /// keep an EMPTY ``photoURL`` and are displayed via a signed URL keyed only on
    /// the path, so a rotate leaves every URL string unchanged and the thumbnail
    /// caches (``ItemPhotoThumbnail``/``CachedThumbnail``/``ThumbnailLoader``)
    /// keep serving the STALE pixels — the rotation appears to silently no-op.
    /// Threading this token into the display key + the signed URL's query busts
    /// those caches without changing what the server sees. Public photos bust via
    /// a `?v=` query on ``photoURL`` instead and don't need this. Never synced to
    /// the server (a fresh pull re-downloads the already-rotated bytes at token 0).
    var localCacheToken: Int = 0

    var createdAt: Date

    /// True when this photo was captured offline and not yet uploaded. The
    /// raw image bytes live in the file system under `photos/<id>.<ext>`;
    /// the upload mutation in PendingMutation refers to them by id.
    var localBytesPath: String?

    init(
        id: String,
        inventoryItemId: String,
        photoType: String,
        photoRole: String? = nil,
        photoURL: String,
        sortOrder: Int = 0,
        createdAt: Date = .now,
        localBytesPath: String? = nil
    ) {
        self.id = id
        self.inventoryItemId = inventoryItemId
        self.photoType = photoType
        self.photoRole = photoRole
        self.photoURL = photoURL
        self.sortOrder = sortOrder
        self.createdAt = createdAt
        self.localBytesPath = localBytesPath
    }
}
