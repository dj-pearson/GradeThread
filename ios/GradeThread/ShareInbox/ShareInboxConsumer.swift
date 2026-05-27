import Foundation
import UIKit

/// Drains ``IntakeInbox`` batches written by the Share Extension and
/// materialises them into the `[PhotoSlotType: PhotoCapture]` shape
/// ``PhotoIntakeView/init(initialPhotos:)`` expects. The Share Extension
/// JPEG-encodes its own payloads, so this layer skips the recompress
/// step the camera flow uses + maps slot raw values back to typed cases.
///
/// `IntakeInbox` itself lives in the Shared/ target so the Share
/// Extension can import it without dragging in the main app's modules.
/// This consumer is main-app-only because it depends on PhotoCapture +
/// PhotoSlotType.
@MainActor
enum ShareInboxConsumer {

    /// One drained batch ready to seed a PhotoIntakeView. `slotPhotos`
    /// is empty when every image in the batch failed to decode.
    /// `Identifiable` so SwiftUI's `.fullScreenCover(item:)` can present
    /// it without us bridging through a separate optional flag.
    struct DrainedBatch: Identifiable {
        let batch: IntakeInbox.Batch
        let slotPhotos: [PhotoSlotType: PhotoCapture]

        var id: String { batch.id }
    }

    /// Pops the oldest pending batch off the inbox + returns the
    /// materialised photos. Returns nil when the inbox is empty or
    /// every photo decode failed (the empty batch is consumed either
    /// way so a corrupted share doesn't replay forever).
    static func popNext() -> DrainedBatch? {
        let batches = IntakeInbox.pendingBatches()
        guard let next = batches.first else { return nil }

        var mapped: [PhotoSlotType: PhotoCapture] = [:]
        for entry in IntakeInbox.materializePhotos(in: next) {
            guard let slot = PhotoSlotType(rawValue: entry.slot),
                  // Build a thumbnail at the same size the camera flow
                  // uses so the slot strip preview looks consistent.
                  let thumbnail = entry.image.preparingThumbnail(of: thumbnailSize)
            else { continue }
            // Skip if the slot already has a photo — first write wins so
            // share-side ordering is preserved. The user can still tap
            // the slot in PhotoIntakeView to retake.
            if mapped[slot] != nil { continue }
            mapped[slot] = PhotoCapture(
                imageData: entry.bytes,
                thumbnail: thumbnail,
                source: .library
            )
        }

        if mapped.isEmpty {
            // Empty batch — consume so the bad share doesn't replay,
            // but signal no photos so the caller can skip the present.
            IntakeInbox.consume(next)
            return DrainedBatch(batch: next, slotPhotos: [:])
        }
        return DrainedBatch(batch: next, slotPhotos: mapped)
    }

    /// Removes the batch's files from the App Group container. Caller
    /// invokes this once the user has dismissed the PhotoIntakeView so
    /// the same share doesn't reappear on the next launch.
    static func finish(_ drained: DrainedBatch) {
        IntakeInbox.consume(drained.batch)
    }

    /// Same dimension PhotoLibraryPicker uses (US-174).
    private static let thumbnailSize = CGSize(width: 240, height: 240)
}
