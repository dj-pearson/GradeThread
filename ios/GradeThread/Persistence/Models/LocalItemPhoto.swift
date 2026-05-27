import Foundation
import SwiftData

/// Local mirror of `item_photos`. One row per photo on disk.
@Model
final class LocalItemPhoto {
    @Attribute(.unique) var id: String
    var inventoryItemId: String

    var photoType: String     // front, back, tag, detail, defect, flatlay, on_model
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
