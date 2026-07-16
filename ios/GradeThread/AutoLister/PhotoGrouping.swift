import Foundation

// Auto-group a dumped batch of photos into per-item listing groups. Resellers
// shoot one item, pause, shoot the next; the capture-time gap is the primary
// "new item" signal. Pure + side-effect-free so it's unit-tested without any UI.
//
// Ported from the web `src/lib/autolister-grouping.ts`, now at full parity:
//   • time-gap clustering (v1),
//   • US-1547: the filename-sequence signal — photos WITHOUT capture time
//     (AirDrop/WhatsApp exports, screenshots) group by contiguous camera
//     sequences (IMG_0551..0554) instead of all becoming singletons, and
//   • US-1548: the dHash visual merge pass — groups whose photos are visually
//     near-identical (Hamming ≤ 10 on a 64-bit dHash) merge, catching
//     out-of-order shots of one garment. Hashes are supplied by the caller
//     (computed off-main via ``DHash``); photos without one simply don't
//     participate, and
//   • US-1909: the web's mega-group guards (ported from US-1550) — the WEAK
//     signals (filename runs, dHash merges) are bounded by group size and
//     shooting-order locality so a same-background dump can't chain into one
//     giant group. Time-gap clusters are exempt: a real EXIF burst is a strong
//     signal and may legitimately be long, so the cap never splits one.

/// A photo eligible for grouping. `capturedAt` is the EXIF/library creation
/// time; nil when unknown. `sourceName` is the original filename (US-1547),
/// nil when the provider didn't supply one.
struct GroupablePhoto: Equatable {
    let id: String
    let capturedAt: Date?
    var sourceName: String?

    init(id: String, capturedAt: Date?, sourceName: String? = nil) {
        self.id = id
        self.capturedAt = capturedAt
        self.sourceName = sourceName
    }
}

/// A derived item group: its photos in capture order, plus the chosen cover
/// (the earliest shot).
struct AutoGroup: Equatable {
    var photoIds: [String]
    var coverId: String
}

/// US-1547: a parsed camera filename — the lowercased prefix up to the trailing
/// number, and that number. Mirrors the web `parseFilenameSequence`.
struct FilenameSequence: Equatable {
    let prefix: String
    let seq: Int
}

enum PhotoGrouping {
    /// Capture-time gap (seconds) that starts a new item. Mirrors the web
    /// `DEFAULT_GAP_SECONDS` in `src/lib/reconcile-cluster.ts`.
    static let defaultGapSeconds: TimeInterval = 30

    /// US-1548: dHash distance at/below which two photos are treated as the
    /// same shot. Mirrors the web `VISUAL_MERGE_MAX_DISTANCE`.
    static let visualMergeMaxDistance = 10

    /// US-1909: ceiling on how many photos the WEAK signals (filename runs,
    /// dHash merges) will pile into one item. Nobody shoots more than about a
    /// dozen photos of one garment, so anything the heuristics grow past this
    /// is far more likely a detection failure than a real item. Mirrors the web
    /// `MAX_AUTO_GROUP_PHOTOS`. Time-gap clusters are exempt — the cap bounds
    /// what the heuristics may GROW, it never splits an EXIF burst.
    static let maxAutoGroupPhotos = 12

    /// US-1909: how far apart (in shooting order, measured in group ordinals)
    /// two groups may sit and still be joined by the visual pass. People shoot
    /// items back-to-back: a same-garment reshoot lands a couple of groups
    /// away, while a "similar" pair spanning half the dump is a same-background
    /// false positive. Mirrors the web `VISUAL_MERGE_ORDINAL_WINDOW`.
    static let visualMergeOrdinalWindow = 3

    /// Group photos by capture-time bursts, then seed groups for the TIMELESS
    /// photos from filename-sequence runs (US-1547), then merge visually
    /// near-identical groups when `hashes` are supplied (US-1548). Ordering is
    /// deterministic and matches web: timed groups by capture time, then
    /// sequence groups by (prefix, number), then unparseable singletons in
    /// input order; within a group, capture time → sequence → input order.
    static func autoGroup(
        _ photos: [GroupablePhoto],
        gapSeconds: TimeInterval = defaultGapSeconds,
        hashes: [String: UInt64] = [:]
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

        // US-1547: timeless photos used to ALL become singletons. Contiguous
        // filename-sequence runs now seed groups for them (a run of one still
        // becomes its own group — identical output to the old singleton, but
        // eligible for the visual merge below). Unparseable names keep the old
        // behavior: singleton groups in input order.
        let runs = sequenceRuns(timeless)
        let inRuns = Set(runs.flatMap { $0.map(\.id) })
        for run in runs {
            // US-1909: a contiguous run only signals "one item" while it's
            // plausibly one item's shoot. A no-EXIF dump has ONE contiguous run
            // spanning the whole folder (600 photos ⇒ one giant group). Past
            // the cap, seed each photo as its own group instead: the run still
            // contributes shooting ORDER (the bounded visual pass below merges
            // neighbours), just not a single boundary-free mega-group.
            if run.count <= maxAutoGroupPhotos {
                groups.append(makeGroup(run))
            } else {
                for photo in run {
                    groups.append(AutoGroup(photoIds: [photo.id], coverId: photo.id))
                }
            }
        }
        for photo in timeless where !inRuns.contains(photo.id) {
            groups.append(AutoGroup(photoIds: [photo.id], coverId: photo.id))
        }

        // US-1548: visual second pass — merge groups whose photos are
        // near-identical (out-of-order shots of the same garment).
        if !hashes.isEmpty {
            groups = mergeSimilarGroups(groups, hashes: hashes)
        }
        return groups
    }

    private static func makeGroup(_ photos: [GroupablePhoto]) -> AutoGroup {
        let ids = photos.map(\.id)
        return AutoGroup(photoIds: ids, coverId: ids.first ?? "")
    }

    // MARK: - US-1547: filename-sequence signal

    /// Parse (prefix, sequence) from a camera filename: the LAST run of digits
    /// in the basename is the sequence, which covers IMG_NNNN, DSCNNNNN,
    /// DSC_NNNN, IMG-NNNN, WhatsApp's IMG-YYYYMMDD-WANNNN and Pixel's
    /// PXL_…_HHMMSSmmm generically. Case-insensitive; strips the extension and
    /// copy suffixes (" (1)", "- Copy", "copy 2") first so a duplicate's copy
    /// number is never mistaken for the sequence. Mirrors web US-1540.
    static func parseFilenameSequence(_ name: String?) -> FilenameSequence? {
        guard var base = name?.trimmingCharacters(in: .whitespacesAndNewlines),
              !base.isEmpty else { return nil }
        base = base.replacingOccurrences(
            of: #"\.[a-z0-9]+$"#, with: "", options: [.regularExpression, .caseInsensitive]
        )
        base = base.replacingOccurrences(
            of: #"\s*\(\d+\)\s*$"#, with: "", options: .regularExpression
        )
        base = base.replacingOccurrences(
            of: #"\s*-?\s*copy(\s*\d+)?\s*$"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        guard let match = base.range(of: #"\d+$"#, options: .regularExpression),
              let seq = Int(base[match]) else { return nil }
        return FilenameSequence(
            prefix: String(base[..<match.lowerBound]).lowercased(),
            seq: seq
        )
    }

    /// Partition photos into contiguous filename-sequence runs: sorted by
    /// (prefix, seq), a run continues while the prefix matches and the number
    /// advances by exactly 1 (or repeats — duplicates stay together); a gap or
    /// prefix change starts a new run. Photos without a parseable sequence are
    /// omitted (the caller leaves them as singletons). Mirrors web US-1540.
    static func sequenceRuns(_ photos: [GroupablePhoto]) -> [[GroupablePhoto]] {
        let parsed = photos.enumerated()
            .compactMap { index, photo -> (photo: GroupablePhoto, seq: FilenameSequence, index: Int)? in
                guard let seq = parseFilenameSequence(photo.sourceName) else { return nil }
                return (photo, seq, index)
            }
            .sorted {
                if $0.seq.prefix != $1.seq.prefix { return $0.seq.prefix < $1.seq.prefix }
                if $0.seq.seq != $1.seq.seq { return $0.seq.seq < $1.seq.seq }
                return $0.index < $1.index
            }

        var runs: [[GroupablePhoto]] = []
        var current: [GroupablePhoto] = []
        var previous: FilenameSequence?
        for entry in parsed {
            let contiguous = previous != nil &&
                entry.seq.prefix == previous!.prefix &&
                (entry.seq.seq == previous!.seq || entry.seq.seq == previous!.seq + 1)
            if !contiguous && !current.isEmpty {
                runs.append(current)
                current = []
            }
            current.append(entry.photo)
            previous = entry.seq
        }
        if !current.isEmpty { runs.append(current) }
        return runs
    }

    /// US-1909: deterministic provenance ordering — capture time first (unknown
    /// last), then filename sequence (prefix, then number; unparseable last).
    /// Ties return 0 so a STABLE sort preserves the caller's (import) order as
    /// the final key. Mirrors the web `compareByProvenance`.
    static func compareByProvenance(
        capturedAt: Date?,
        sourceName: String?,
        otherCapturedAt: Date?,
        otherSourceName: String?
    ) -> Int {
        switch (capturedAt, otherCapturedAt) {
        case let (a?, b?) where a != b: return a < b ? -1 : 1
        case (_?, nil): return -1 // a known time sorts before an unknown one
        case (nil, _?): return 1
        default: break // both nil, or equal times → fall through to filename
        }
        switch (parseFilenameSequence(sourceName), parseFilenameSequence(otherSourceName)) {
        case let (a?, b?):
            if a.prefix != b.prefix { return a.prefix < b.prefix ? -1 : 1 }
            if a.seq != b.seq { return a.seq < b.seq ? -1 : 1 }
            return 0
        case (_?, nil): return -1
        case (nil, _?): return 1
        case (nil, nil): return 0
        }
    }

    // MARK: - US-1548: dHash visual merge pass

    /// Merge groups containing visually near-identical photos, BOUNDED (US-1909,
    /// mirroring the web `applyBoundedVisualMerge`). dHash on clothing photos is
    /// dominated by the shared background, so an unbounded transitive union
    /// chains nearly every group of a big dump into one mega-group. This applies
    /// the CLOSEST pairs first and refuses a merge that would either (a) grow a
    /// group past `maxAutoGroupPhotos` or (b) join two groups more than
    /// `visualMergeOrdinalWindow` apart in shooting order. `groups` is expected
    /// in shooting order (as `autoGroup` emits it), so a group's index IS its
    /// ordinal. Photos without a hash never match. Merged groups keep the
    /// earlier group's position and cover; the later group's photos append in
    /// their existing order.
    static func mergeSimilarGroups(
        _ groups: [AutoGroup],
        hashes: [String: UInt64],
        maxDistance: Int = visualMergeMaxDistance
    ) -> [AutoGroup] {
        guard groups.count > 1 else { return groups }

        // Union-find over group indices, tracking size + the ordinal range each
        // component covers, so both bounds can be checked before a merge.
        var parent = Array(0..<groups.count)
        var size = groups.map(\.photoIds.count)
        var minOrd = Array(0..<groups.count)
        var maxOrd = Array(0..<groups.count)
        func root(_ x: Int) -> Int {
            var r = x
            while parent[r] != r { r = parent[r] }
            var cur = x
            while parent[cur] != cur {
                let next = parent[cur]
                parent[cur] = r
                cur = next
            }
            return r
        }

        let groupHashes: [[UInt64]] = groups.map { g in
            g.photoIds.compactMap { hashes[$0] }
        }
        // Closest pair per group pair, so when a bound bites it's the weakest
        // (most-likely-false) merges that lose out.
        var pairs: [(a: Int, b: Int, distance: Int)] = []
        for i in 0..<groups.count {
            for j in (i + 1)..<groups.count {
                var best = Int.max
                for ha in groupHashes[i] {
                    for hb in groupHashes[j] {
                        best = min(best, DHash.hammingDistance(ha, hb))
                    }
                }
                if best <= maxDistance { pairs.append((i, j, best)) }
            }
        }
        // Stable: equal distances keep (a, b) index order so output is
        // deterministic regardless of the sort's internal ordering.
        pairs.sort { $0.distance != $1.distance ? $0.distance < $1.distance
            : ($0.a != $1.a ? $0.a < $1.a : $0.b < $1.b) }

        for pair in pairs {
            let ra = root(pair.a)
            let rb = root(pair.b)
            if ra == rb { continue }
            if size[ra] + size[rb] > maxAutoGroupPhotos { continue }
            // Gap between the two components' ordinal ranges (0 when they overlap).
            let gap = max(minOrd[ra], minOrd[rb]) - min(maxOrd[ra], maxOrd[rb])
            if gap > visualMergeOrdinalWindow { continue }
            let (keep, drop) = (min(ra, rb), max(ra, rb))
            parent[drop] = keep
            size[keep] = size[ra] + size[rb]
            minOrd[keep] = min(minOrd[ra], minOrd[rb])
            maxOrd[keep] = max(maxOrd[ra], maxOrd[rb])
        }

        var merged: [Int: AutoGroup] = [:]
        var order: [Int] = []
        for (i, group) in groups.enumerated() {
            let r = root(i)
            if var existing = merged[r] {
                existing.photoIds.append(contentsOf: group.photoIds)
                merged[r] = existing
            } else {
                merged[r] = group
                order.append(r)
            }
        }
        return order.compactMap { merged[$0] }
    }
}
