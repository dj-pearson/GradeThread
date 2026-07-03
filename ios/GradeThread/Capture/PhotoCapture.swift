import Foundation
import UIKit

/// One captured photo ready for upload. `imageData` is the JPEG payload
/// (already compressed via ``PhotoCompressor``); `thumbnail` is a small
/// UIImage cached for the slot strip so we don't decode the full image on
/// every redraw.
public struct PhotoCapture: Identifiable, Hashable {
    public let id: UUID
    public let imageData: Data
    public let thumbnail: UIImage
    public let capturedAt: Date
    public let source: Source
    /// US-1547: the source file's original name (e.g. "IMG_0551.jpg") from the
    /// library item provider. nil for camera captures / providers without one.
    /// Drives filename-sequence grouping and is persisted onto item_photos as
    /// `original_filename` (00339 provenance).
    public let sourceName: String?

    public enum Source: Hashable {
        case camera
        case library
    }

    public init(
        id: UUID = UUID(),
        imageData: Data,
        thumbnail: UIImage,
        capturedAt: Date = .now,
        source: Source = .camera,
        sourceName: String? = nil
    ) {
        self.id = id
        self.imageData = imageData
        self.thumbnail = thumbnail
        self.capturedAt = capturedAt
        self.source = source
        self.sourceName = sourceName
    }

    /// Equality only by id so SwiftUI diffing doesn't recompute on every
    /// thumbnail decode.
    public static func == (lhs: PhotoCapture, rhs: PhotoCapture) -> Bool {
        lhs.id == rhs.id
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}
