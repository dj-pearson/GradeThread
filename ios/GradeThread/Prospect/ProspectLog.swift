import Foundation
import SwiftData
import UIKit

/// US-3100 — the sourcing log Prospect never kept.
///
/// A seller working a rack scans six garments in ten minutes, buys two and
/// walks out. An hour later they cannot remember which of the four they passed
/// on was the close call, because the verdict lived in a sheet and the sheet
/// closed. Going back means re-scanning: a second metered AI action for an
/// answer we already had, assuming they can even find the garment again.
///
/// So every successful scan is written down, the last ``keepCount`` are kept,
/// and the rest are dropped. All of it is local — see ``LocalProspectResult``
/// for why nothing here is synced.
///
/// **The pruning and the mapping are static and pure**, so what this type
/// decides can be tested by reading it rather than by standing up a store. The
/// instance methods are the thin SwiftData wrapper around those decisions.
@MainActor
struct ProspectLog {

    /// How many verdicts survive.
    ///
    /// Twenty is about two hours of hard sourcing. Beyond that the seller is
    /// looking for something they scanned on a different trip, which is a
    /// search problem and not this one — and every kept row holds a photo.
    static let keepCount = 20

    /// The longest edge of the stored thumbnail, in points.
    ///
    /// The Home row renders it at 44pt, so 240 covers a 3x screen with room for
    /// a larger row later. Full-frame captures are 3-10 MB; twenty of those is
    /// a quarter of a gigabyte spent on twenty postage stamps.
    static let thumbnailLongEdge: CGFloat = 240

    private let context: ModelContext
    private let userId: String

    init(context: ModelContext, userId: String) {
        self.context = context
        self.userId = userId
    }

    // MARK: - Writing

    /// Write a verdict down and prune the tenant back to ``keepCount``.
    ///
    /// Returns the new row's id so the caller can stamp it with an inventory id
    /// later. Nil when there was nothing worth keeping or the write failed —
    /// a failure here must never surface to a seller standing in a shop, whose
    /// scan succeeded regardless of whether we managed to remember it.
    @discardableResult
    func record(_ result: ProspectResponse, thumbnail: UIImage?) -> String? {
        guard result.identified else { return nil }

        let row = LocalProspectResult(
            userId: userId,
            title: result.item.title,
            brand: result.item.brand,
            categoryId: result.category?.id,
            categoryPath: result.category?.path,
            gradeValue: result.grade?.value,
            gradeTier: result.grade?.tier,
            medianCents: result.stats?.medianCents,
            lowCents: result.stats?.lowCents,
            highCents: result.stats?.highCents,
            decision: result.decision?.recommendation,
            ceilingCents: result.ceiling?.maxPriceCents,
            costCents: result.costCents,
            thumbnailData: thumbnail.flatMap(Self.thumbnailData)
        )
        context.insert(row)
        prune()
        do {
            try context.save()
        } catch {
            return nil
        }
        return row.id
    }

    /// Link a saved verdict to the inventory row it became, so the log can say
    /// "Added" rather than offering to add the same garment twice.
    func markAdded(rowId: String, itemId: String) {
        guard let row = self.row(id: rowId) else { return }
        row.addedItemId = itemId
        try? context.save()
    }

    // MARK: - Reading

    /// The newest verdicts for this tenant.
    ///
    /// Filtered on `userId` even though the cache is wiped on every workspace
    /// switch and sign-out. Both belt and braces are wanted here: the wipe is
    /// best-effort by design (it swallows its own errors), and the failure it
    /// would leave behind is one seller reading another's sourcing list.
    func recent(limit: Int = 5) -> [LocalProspectResult] {
        let tenant = userId
        var descriptor = FetchDescriptor<LocalProspectResult>(
            predicate: #Predicate { $0.userId == tenant },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        descriptor.fetchLimit = limit
        return (try? context.fetch(descriptor)) ?? []
    }

    func row(id: String) -> LocalProspectResult? {
        let descriptor = FetchDescriptor<LocalProspectResult>(
            predicate: #Predicate { $0.id == id }
        )
        return try? context.fetch(descriptor).first
    }

    // MARK: - Pruning

    /// Drop everything past ``keepCount`` for this tenant.
    ///
    /// Runs inside the same save as the insert, so the cap holds even if the
    /// app is killed the moment after a scan.
    private func prune() {
        let tenant = userId
        let all = (try? context.fetch(
            FetchDescriptor<LocalProspectResult>(
                predicate: #Predicate { $0.userId == tenant },
                sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
            )
        )) ?? []
        for row in Self.rowsToPrune(all, keep: Self.keepCount) {
            context.delete(row)
        }
    }

    /// Which rows fall off the end, given every row NEWEST FIRST.
    ///
    /// Pure, and separate from the fetch, because the off-by-one here is the
    /// whole rule: keeping 20 means dropping from index 20, not 19, and a log
    /// that quietly holds 19 is indistinguishable from one that holds 20 until
    /// somebody counts.
    static func rowsToPrune(
        _ newestFirst: [LocalProspectResult],
        keep: Int = keepCount
    ) -> [LocalProspectResult] {
        guard newestFirst.count > keep else { return [] }
        return Array(newestFirst.dropFirst(keep))
    }

    // MARK: - Thumbnails

    /// JPEG bytes for the row's thumbnail, upright and small.
    ///
    /// Goes through ``PhotoCompressor`` rather than `jpegData` directly: a raw
    /// encode records orientation as an EXIF flag, and every consumer that
    /// ignores that flag renders the photo sideways. The Home row is such a
    /// consumer, and a sideways thumbnail of a garment is a garment nobody
    /// recognises.
    static func thumbnailData(_ image: UIImage) -> Data? {
        PhotoCompressor.compress(
            image,
            maxLongEdge: thumbnailLongEdge,
            quality: 0.6
        )?.imageData
    }
}
