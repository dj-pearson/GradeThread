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

    public enum Source: Hashable {
        case camera
        case library
    }

    public init(
        id: UUID = UUID(),
        imageData: Data,
        thumbnail: UIImage,
        capturedAt: Date = .now,
        source: Source = .camera
    ) {
        self.id = id
        self.imageData = imageData
        self.thumbnail = thumbnail
        self.capturedAt = capturedAt
        self.source = source
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
