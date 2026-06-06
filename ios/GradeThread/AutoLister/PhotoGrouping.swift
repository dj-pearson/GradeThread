import Foundation

// Auto-group a dumped batch of photos into per-item listing groups by
// capture-time bursts. Resellers shoot one item, pause, shoot the next; the gap
// is a strong "new item" signal. Pure + side-effect-free so it's unit-tested
// without any UI.
//
// This is the v1 of the AutoLister grouping ported from the web
// `src/lib/autolister-grouping.ts`. The web additionally runs a dHash visual
// second pass (merging out-of-order shots of one garment); iOS computes no
// perceptual hash yet, so that pass is deferred to v2. Time-gap clustering alone
// is the dominant signal for a library dump that carries EXIF capture times.

/// A photo eligible for grouping. `capturedAt` is the EXIF/library creation
/// time; nil when unknown (e.g. a future in-camera capture).
struct GroupablePhoto: Equatable {
    let id: String
    let capturedAt: Date?
}

/// A derived item group: its photos in capture order, plus the chosen cover
/// (the earliest shot).
struct AutoGroup: Equatable {
    var photoIds: [String]
    var coverId: String
}

enum PhotoGrouping {
    /// Capture-time gap (seconds) that starts a new item. Mirrors the web
    /// `DEFAULT_GAP_SECONDS` in `src/lib/reconcile-cluster.ts`.
    static let defaultGapSeconds: TimeInterval = 30

    /// Group photos by capture-time bursts. Photos carrying a `capturedAt` are
    /// sorted ascending and split whenever the gap to the previous photo
    /// exceeds `gapSeconds`; each group's cover is its earliest shot. Photos
    /// with no capture time become their own singleton groups (nothing is
    /// silently dropped — the user can merge them in review). Input order is
    /// preserved for the timeless singletons.
    static func autoGroup(
        _ photos: [GroupablePhoto],
        gapSeconds: TimeInterval = defaultGapSeconds
    ) -> [AutoGroup] {
        if photos.isEmpty { return [] }

        let timed = photos
            .filter { $0.capturedAt != nil }
            .sorted { $0.capturedAt! < $1.capturedAt! }
        let timeless = photos.filter { $0.capturedAt == nil }

        var groups: [AutoGroup] = []
        var current: [GroupablePhoto] = []
        var previous: Date?

        for photo in timed {
            let at = photo.capturedAt!
            if let prev = previous, at.timeIntervalSince(prev) > gapSeconds {
                groups.append(makeGroup(current))
                current = []
            }
            current.append(photo)
            previous = at
        }
        if !current.isEmpty { groups.append(makeGroup(current)) }

        // Timeless photos each stand alone, appended in original order.
        for photo in timeless {
            groups.append(AutoGroup(photoIds: [photo.id], coverId: photo.id))
        }

        return groups
    }

    private static func makeGroup(_ photos: [GroupablePhoto]) -> AutoGroup {
        let ids = photos.map(\.id)
        return AutoGroup(photoIds: ids, coverId: ids.first ?? "")
    }
}
