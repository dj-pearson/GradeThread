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
//     participate.

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
            groups.append(makeGroup(run))
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

    // MARK: - US-1548: dHash visual merge pass

    /// Merge groups containing visually near-identical photos: any cross-group
    /// pair within `maxDistance` unions the two groups (transitively, via
    /// union-find — mirrors the web `applyVisualSecondPass`). Photos without a
    /// hash never match. Merged groups keep the earlier group's position and
    /// cover; the later group's photos append in their existing order.
    static func mergeSimilarGroups(
        _ groups: [AutoGroup],
        hashes: [String: UInt64],
        maxDistance: Int = visualMergeMaxDistance
    ) -> [AutoGroup] {
        guard groups.count > 1 else { return groups }

        // Union-find over group indices.
        var parent = Array(0..<groups.count)
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
        func union(_ a: Int, _ b: Int) {
            let ra = root(a)
            let rb = root(b)
            if ra != rb { parent[max(ra, rb)] = min(ra, rb) }
        }

        let groupHashes: [[UInt64]] = groups.map { g in
            g.photoIds.compactMap { hashes[$0] }
        }
        for i in 0..<groups.count {
            for j in (i + 1)..<groups.count where root(i) != root(j) {
                outer: for ha in groupHashes[i] {
                    for hb in groupHashes[j] where DHash.hammingDistance(ha, hb) <= maxDistance {
                        union(i, j)
                        break outer
                    }
                }
            }
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
