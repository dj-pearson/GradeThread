import Foundation
import SwiftUI
import UIKit

/// Receives images dragged from Photos.app (or any UTI=public.image
/// source) and converts them through the same PhotoCompressor pipeline
/// the in-app capture flow uses. Results are returned as a
/// `[PhotoCapture]` so the caller can stage them in a
/// ``PhotoIntakeStore`` and present ``PhotoIntakeView``.
@MainActor
enum PhotosDropHandler {

    /// Processes an array of dropped `UIImage`s into ``PhotoCapture``
    /// values. Compression failures drop silently — partial success is
    /// preferable to forcing the user to start over because one of
    /// five drops didn't materialise.
    static func process(_ images: [UIImage]) async -> [PhotoCapture] {
        // US-636: compress off the main actor with bounded concurrency so a big
        // multi-image drop doesn't freeze the UI or spike memory.
        let outputs = await PhotoCompressor.compressBatch(images)
        return outputs.compactMap { output in
            guard let output else { return nil }
            return PhotoCapture(
                imageData: output.imageData,
                thumbnail: output.thumbnail,
                source: .library
            )
        }
    }
}

/// SwiftUI modifier that wires `.dropDestination(for: Data.self)` to a
/// completion handler that decodes JPEG/PNG payloads. Photos.app drags
/// publish images as `public.image` UTI which arrives at SwiftUI's
/// `.dropDestination(for: Image.self)` handler — but Image isn't a
/// Transferable we can convert back to UIImage easily. Going through
/// raw Data is the reliable path: every Photos.app drag carries the
/// JPEG/PNG bytes.
extension View {
    /// Accept image drops + funnel the decoded UIImages to the handler.
    /// Used by InventoryListView at the list level so the user can
    /// drag images from Photos.app onto the whole list (we don't need
    /// per-row drop semantics — every drop opens the intake flow).
    func acceptsImageDrops(perform action: @escaping ([UIImage]) -> Void) -> some View {
        self.dropDestination(for: Data.self) { dataList, _ in
            let images = dataList.compactMap { UIImage(data: $0) }
            guard !images.isEmpty else { return false }
            action(images)
            return true
        }
    }
}
