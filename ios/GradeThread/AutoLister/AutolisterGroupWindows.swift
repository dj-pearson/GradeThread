import Foundation

// US-1909: client-side windowing for the AutoLister AI passes, ported from the
// web `src/lib/autolister-verify-windows.ts` (US-1903) and
// `src/lib/autolister-propose-windows.ts` (US-1904). Pure + side-effect-free so
// it unit-tests without any network or UI.
//
// Both edge endpoints score ONE window of at most `MAX_VERIFY_PHOTOS` sample
// photos per request (see services/edge-functions/src/lib/ai-group-verify.ts).
// A big session therefore only ever got its first ~13 groups checked in a single
// call. These helpers walk ALL groups / photos across sequential windows that
// each map to exactly one request, so coverage is complete and the results
// aggregate back into one list.

enum AutolisterWindows {

    // MARK: - US-1903: verify-groups windowing

    /// Mirror of `MAX_VERIFY_PHOTOS` in ai-group-verify.ts — the server's
    /// per-request sample-photo budget. Keep the two in lockstep.
    static let maxVerifySamplePhotos = 40

    /// How many photos a group contributes to a window's sample budget. Mirrors
    /// the server's sampling: first/middle/last for a group with >3 photos,
    /// otherwise every photo; an empty group contributes nothing (skipped).
    static func sampledSizeForVerify(photoCount: Int) -> Int {
        photoCount <= 0 ? 0 : min(3, photoCount)
    }

    /// Partition ordered groups into sequential windows whose total sampled-photo
    /// size fits `budget`, never splitting a group across windows. Mirrors the
    /// server's maximal-prefix packing so each window is exactly one
    /// /verify-groups request. Empty groups are dropped. A single group can never
    /// exceed the budget (≤3 sampled ≤ budget), so it always lands in a window.
    static func planVerifyWindows<T>(
        _ groups: [T],
        budget: Int = maxVerifySamplePhotos,
        photoCount: (T) -> Int
    ) -> [[T]] {
        var windows: [[T]] = []
        var current: [T] = []
        var used = 0
        for group in groups {
            let size = sampledSizeForVerify(photoCount: photoCount(group))
            if size == 0 { continue }
            if !current.isEmpty && used + size > budget {
                windows.append(current)
                current = []
                used = 0
            }
            current.append(group)
            used += size
        }
        if !current.isEmpty { windows.append(current) }
        return windows
    }

    /// Stable key for de-duplicating suggestions aggregated across windows, by
    /// (type, groupIds, photoIds). A merge/split's group ids are unordered so
    /// [a,b] and [b,a] collapse; a move is directional so its [from,to] order is
    /// preserved. The photo set is always order-insensitive. Mirrors the web
    /// `suggestionDedupeKey`.
    static func suggestionDedupeKey(_ s: GroupVerifySuggestion) -> String {
        let groups = s.type == "move" ? s.groupIds : s.groupIds.sorted()
        let photos = s.photoIds.sorted()
        return "\(s.type)|\(groups.joined(separator: ","))|\(photos.joined(separator: ","))"
    }

    /// Drop later duplicates, keeping the first occurrence's order.
    static func dedupeSuggestions(_ rows: [GroupVerifySuggestion]) -> [GroupVerifySuggestion] {
        var seen = Set<String>()
        var out: [GroupVerifySuggestion] = []
        for row in rows where seen.insert(suggestionDedupeKey(row)).inserted {
            out.append(row)
        }
        return out
    }

    // MARK: - US-1904: propose-groups windowing

    /// Photos per propose request — mirrors the server's per-window cap.
    static let proposeWindow = 40
    /// Photos shared between adjacent windows so a seam-spanning item isn't split.
    static let proposeOverlap = 4

    /// Split ordered photo ids into windows of at most `windowSize`, where each
    /// window after the first repeats the last `overlap` ids of the previous one.
    /// The overlap never exceeds windowSize-1, so progress is always guaranteed.
    /// Mirrors the web `planProposeWindows`.
    static func planProposeWindows(
        _ ids: [String],
        windowSize: Int = proposeWindow,
        overlap: Int = proposeOverlap
    ) -> [[String]] {
        if ids.isEmpty { return [] }
        if ids.count <= windowSize { return [ids] }
        let step = max(1, windowSize - min(overlap, windowSize - 1))
        var windows: [[String]] = []
        var start = 0
        while start < ids.count {
            windows.append(Array(ids[start..<min(start + windowSize, ids.count)]))
            if start + windowSize >= ids.count { break } // last window reached the end
            start += step
        }
        return windows
    }

    /// Merge per-window proposals into one flat, de-duplicated group list, in
    /// photo order. A group sharing any photo with the previous merged group (the
    /// window overlap) EXTENDS it — that's the seam-spanning item — keeping the
    /// original boundary's confidence/reason. A group of all-new photos is a
    /// fresh item. A group entirely inside the overlap (nothing new) is dropped.
    /// Mirrors the web `mergeProposalWindows`.
    static func mergeProposalWindows(
        _ windows: [[ClientProposedGroup]]
    ) -> [ClientProposedGroup] {
        var result: [ClientProposedGroup] = []
        var assigned = Set<String>()
        for window in windows {
            for group in window {
                let newIds = group.photoIds.filter { !assigned.contains($0) }
                if newIds.isEmpty { continue } // fully within the overlap
                let continuesLast = result.last.map { last in
                    group.photoIds.contains { assigned.contains($0) && last.photoIds.contains($0) }
                } ?? false
                if continuesLast {
                    result[result.count - 1].photoIds.append(contentsOf: newIds)
                } else {
                    result.append(
                        ClientProposedGroup(
                            photoIds: newIds,
                            confidence: group.confidence,
                            reason: group.reason
                        )
                    )
                }
                assigned.formUnion(newIds)
            }
        }
        return result
    }
}
