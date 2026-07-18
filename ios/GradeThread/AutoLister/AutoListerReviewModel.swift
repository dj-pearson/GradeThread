import PhotosUI
import SwiftUI
import UIKit

/// One reviewable item group: the photos that will become a single listing,
/// plus the chosen cover. Carries its own identity so SwiftUI diffing and the
/// merge/split edits stay stable across regrouping.
struct ReviewGroup: Identifiable, Equatable {
    let id: UUID
    var photoIds: [UUID]
    var coverId: UUID
}

/// A group prepared for generation: photos ordered with the cover first. Phase C
/// consumes this to create the item + upload its photos.
struct PreparedGroup {
    let coverId: UUID
    let photos: [PhotoCapture]
}

/// US-1909: user-selectable ordering for the ungrouped grid, mirroring the web
/// `UngroupedSortMode` (src/pages/flipdesk/autolister.tsx). "Shooting order" is
/// the provenance sort (capture time → filename sequence → import order) and
/// stays the default because it previews the boundaries auto-grouping uses — but
/// exports often strip EXIF, and then the seller needs to see (and group across)
/// their own order instead.
enum UngroupedSortMode: String, CaseIterable, Identifiable {
    case shooting
    case name
    case date
    case upload

    var id: String { rawValue }

    var label: String {
        switch self {
        case .shooting: return "Shooting order"
        case .name: return "File name"
        case .date: return "Date taken"
        case .upload: return "Import order"
        }
    }
}

/// View-model for the AutoLister capture + review screen. Holds the imported
/// photos and their grouping, and the merge/split/cover/delete edits. The edit
/// logic is pure (no UI, no network) so it's unit-tested directly; `importPicks`
/// is the only async/PhotoKit seam.
@MainActor
final class AutoListerReviewModel: ObservableObject {

    @Published private(set) var photosById: [UUID: PhotoCapture] = [:]
    @Published private(set) var groups: [ReviewGroup] = []
    /// US-1548: 64-bit dHash per photo, computed off-main during import. Feeds
    /// the visual merge pass; photos that couldn't hash simply don't participate.
    private var hashesById: [UUID: UInt64] = [:]
    @Published private(set) var isImporting = false
    /// Set when a batch import yields no usable photos (US-1116) — drives a
    /// retryable error state instead of silently dropping back to the empty
    /// state, which reads as "nothing happened".
    @Published private(set) var importError: String?
    /// Transient failure (e.g. a rotate that couldn't re-encode) surfaced as an
    /// alert; the review list stays put.
    @Published var actionError: String?
    /// Non-blocking notice shown as an inline banner (NOT the error state) when
    /// an import was capped at `maxBatchPhotos` — some photos the seller picked
    /// weren't added because a batch is bounded so the serial upload doesn't
    /// leave them waiting. Cleared on the seller's next successful import or when
    /// dismissed.
    @Published var capNotice: String?
    /// US-1548: AI merge/split/move suggestions from the verify-groups pass.
    /// NEVER auto-applied — the user taps Apply or Dismiss per suggestion. A
    /// failed/timed-out verify silently leaves this empty (no blocking UI).
    @Published private(set) var suggestions: [GroupVerifySuggestion] = []
    @Published private(set) var verifying = false
    /// US-1909: progress of a multi-window pass (nil for a single window, which
    /// needs no progress UI). `done`/`total` count the pass's units.
    @Published private(set) var verifyProgress: PassProgress?
    @Published private(set) var proposing = false
    @Published private(set) var proposeProgress: PassProgress?
    /// US-1909: proposed boundaries the model was NOT confident enough to apply
    /// — the seller confirms each one.
    @Published private(set) var proposalReviews: [ClientProposedGroup] = []
    /// US-1909: a >1-window pass costs one AI action PER window, so the seller
    /// confirms the count before it's spent. Non-nil drives the confirm dialog.
    @Published var verifyConfirm: VerifyConfirm?
    @Published var proposeConfirm: ProposeConfirm?
    /// AI actions left this month, for the confirm dialog's pre-count. nil until
    /// loaded (or when the lookup failed — the dialog then just omits it).
    @Published private(set) var aiActionsRemaining: Int?

    /// US-1909: photos that belong to no group. Auto-grouping never leaves any
    /// here (it assigns everything), but the seller can ungroup a photo to
    /// re-sort it, and "AI group remaining" proposes boundaries over this pool.
    @Published private(set) var ungrouped: [UUID] = []
    /// US-1909: persisted like the web's localStorage key so the choice sticks.
    @Published var ungroupedSort: UngroupedSortMode = AutoListerReviewModel.loadSort() {
        didSet { Self.saveSort(ungroupedSort) }
    }

    struct PassProgress: Equatable {
        var done: Int
        var total: Int
    }

    /// A planned multi-window verify pass, held until the seller confirms its
    /// metered cost. One window == one AI action.
    struct VerifyConfirm: Identifiable {
        let id = UUID()
        let windows: [[VerifyGroupPayload]]
        let totalGroups: Int
        var windowCount: Int { windows.count }
    }

    /// A planned multi-window propose pass, held until the seller confirms.
    struct ProposeConfirm: Identifiable {
        let id = UUID()
        let windows: [[String]]
        let photoCount: Int
        var windowCount: Int { windows.count }
    }

    // US-1548: verify-groups plumbing. Boundary samples upload once into the
    // caller's `_staging/` folder (the endpoint's tenant check requires that
    // prefix) and are reused across verify runs in this session.
    private let service: AutolisterBatching
    private var stagedPathByPhotoId: [UUID: String] = [:]
    private let verifySessionId = UUID().uuidString.lowercased()
    /// Hard bandwidth bound on verification uploads per session.
    private static let maxVerifyUploads = 36
    /// US-1909: import order, the `.upload` sort and the provenance tiebreaker
    /// (`photosById` is a dict and carries no order of its own).
    private var importOrder: [UUID] = []
    /// US-1909: photos the library gave NO creation date for. `PhotoCapture`
    /// defaults `capturedAt` to `.now`, so without this the whole timeless dump
    /// looks like one instantaneous burst — a time-gap cluster, which is exempt
    /// from the mega-group guards. Tracking the fabricated times lets grouping
    /// see them as genuinely timeless and use the filename/vision signals.
    private var timelessIds: Set<UUID> = []
    /// US-1909: cancellation flag for a multi-window pass (checked between
    /// windows, so an in-flight request still completes).
    private var passCancelled = false

    private static let sortDefaultsKey = "flipdesk-autolister-ungrouped-sort"

    private static func loadSort() -> UngroupedSortMode {
        UserDefaults.standard.string(forKey: sortDefaultsKey)
            .flatMap(UngroupedSortMode.init(rawValue:)) ?? .shooting
    }

    private static func saveSort(_ mode: UngroupedSortMode) {
        UserDefaults.standard.set(mode.rawValue, forKey: sortDefaultsKey)
    }

    init(service: AutolisterBatching = AutolisterService()) {
        self.service = service
    }

    var isEmpty: Bool { photosById.isEmpty }
    var totalPhotos: Int { photosById.count }

    /// Hard ceiling on photos per bulk batch. Uploads run strictly serially
    /// (`PhotoUploadService.maxConcurrent = 1`, ~1s per ~700 KB PUT against the
    /// self-hosted storage), so an unbounded import would leave the seller
    /// watching a very long upload. Capping the batch keeps the wait predictable
    /// and stays well under the edge worker's `MAX_BATCH_ITEMS = 300` (grouping
    /// collapses these photos into far fewer items). Add more in a second batch.
    static let maxBatchPhotos = 200

    /// Photos that can still be added before hitting `maxBatchPhotos`. Drives the
    /// picker's `selectionLimit` so the seller can't over-pick in the first place.
    var remainingCapacity: Int { max(0, Self.maxBatchPhotos - totalPhotos) }

    /// The batch is full — importing more is blocked until the seller removes
    /// some photos or generates and starts a fresh batch.
    var isAtCapacity: Bool { totalPhotos >= Self.maxBatchPhotos }

    /// Photos imported but auto-grouping produced nothing to review (US-1116).
    /// US-1909: a pool of ungrouped photos IS reviewable (the seller can sort
    /// and AI-group them), so it doesn't count as "couldn't group".
    var hasPhotosButNoGroups: Bool {
        !photosById.isEmpty && groups.isEmpty && ungrouped.isEmpty
    }

    /// Ready to generate when there's at least one group and none is empty.
    var canGenerate: Bool { !groups.isEmpty && groups.allSatisfy { !$0.photoIds.isEmpty } }

    func photos(in group: ReviewGroup) -> [PhotoCapture] {
        group.photoIds.compactMap { photosById[$0] }
    }

    func displayIndex(of group: ReviewGroup) -> Int {
        (groups.firstIndex(where: { $0.id == group.id }) ?? 0) + 1
    }

    // MARK: - Import

    /// Load PHPicker results into `PhotoCapture`s (compress + EXIF capture time,
    /// same path as `PhotoIntakeView.ingestLibraryPicks`) then (re)group. Picks
    /// that can't materialize (e.g. still in iCloud) are skipped.
    func importPicks(_ results: [PHPickerResult]) async {
        isImporting = true
        importError = nil
        capNotice = nil
        defer { isImporting = false }
        // Defensive cap: the picker's `selectionLimit` already bounds a single
        // pick to `remainingCapacity`, but a seller can pick across several
        // sessions ("Add photos"), so truncate here too and tell them how many
        // were left out. The invariant `totalPhotos <= maxBatchPhotos` holds
        // regardless of how the picker was configured.
        let capacity = remainingCapacity
        let picks = Array(results.prefix(capacity))
        let dropped = results.count - picks.count
        if dropped > 0 {
            capNotice = "Added \(picks.count) photo\(picks.count == 1 ? "" : "s") — \(dropped) more weren't included. A batch holds up to \(Self.maxBatchPhotos) photos so the upload doesn't leave you waiting. Generate this batch, then start another."
        }
        var captures: [PhotoCapture] = []
        for result in picks {
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(image) else { continue }
            let creationDate = result.creationDate()
            let capture = PhotoCapture(
                imageData: output.imageData,
                thumbnail: output.thumbnail,
                capturedAt: creationDate ?? .now,
                source: .library,
                // US-1547: the original filename drives sequence grouping and
                // is persisted as item_photos.original_filename at upload.
                sourceName: result.itemProvider.suggestedName
            )
            // US-1909: remember that this photo's time is FABRICATED. Grouping
            // must treat it as timeless (filename/vision signals) rather than as
            // an instantaneous burst, which the guards deliberately exempt.
            if creationDate == nil { timelessIds.insert(capture.id) }
            captures.append(capture)
            // US-1548: hash for the visual merge pass — off-main, alongside the
            // compression this import already does per photo.
            if let hash = await Task.detached(priority: .userInitiated, operation: {
                DHash.compute(image)
            }).value {
                hashesById[capture.id] = hash
            }
        }
        ingest(captures)
        // US-1548: silent post-import verification (mirrors the web's
        // auto-run after auto-group). Fire-and-forget; failures leave no trace.
        if !captures.isEmpty {
            Task { await self.verifyGroupsNow() }
        }
        // The user picked photos but none could be materialized (still syncing
        // from iCloud, undecodable). Surface a retryable error rather than the
        // empty state, which would look like the import never ran (US-1116).
        // Guard on `picks`, not `results`: when the batch was already full every
        // pick is dropped by the cap, which is a `capNotice`, not an iCloud error.
        if captures.isEmpty && !picks.isEmpty {
            importError = picks.count == 1
                ? "Couldn't import that photo. It may still be downloading from iCloud — try again."
                : "Couldn't import those photos. They may still be downloading from iCloud — try again."
        }
    }

    /// Add captures and re-derive groups from capture time. Test seam (callers
    /// pass synthetic `PhotoCapture`s without PhotoKit). Note: a fresh ingest
    /// re-runs auto-grouping over everything, discarding prior manual edits —
    /// acceptable for v1's "import once, then review" flow; the user can also
    /// hit "Auto-group" to reset deliberately.
    func ingest(_ captures: [PhotoCapture]) {
        for c in captures {
            if photosById[c.id] == nil { importOrder.append(c.id) }
            photosById[c.id] = c
        }
        regroupAll()
    }

    /// Test seam (US-1909): ingest photos whose capture time is FABRICATED (the
    /// library gave none), the state `importPicks` derives from a nil
    /// `creationDate`. Exercises the filename-sequence + vision paths that a
    /// real timeless dump takes.
    func ingestTimeless(_ captures: [PhotoCapture]) {
        for c in captures { timelessIds.insert(c.id) }
        ingest(captures)
    }

    // MARK: - Grouping

    /// Re-run clustering over all imported photos: capture-time bursts, the
    /// US-1547 filename-sequence signal for timeless photos, and the US-1548
    /// dHash visual merge pass over whatever hashed during import.
    func regroupAll() {
        // US-1909: iterate importOrder (not the dict's arbitrary order) so ties
        // in the provenance sort resolve to import order, exactly like web.
        let groupables = importOrder.compactMap { id -> GroupablePhoto? in
            guard let photo = photosById[id] else { return nil }
            return GroupablePhoto(
                id: photo.id.uuidString,
                // A fabricated `.now` is NOT a capture time — see `timelessIds`.
                capturedAt: timelessIds.contains(photo.id) ? nil : photo.capturedAt,
                sourceName: photo.sourceName
            )
        }
        // GroupablePhoto ids are lowercase-normalized? UUID.uuidString is
        // uppercase; the hash map below keys by the SAME uuidString, so the
        // round-trip stays consistent either way.
        let hashes = Dictionary(
            hashesById.map { ($0.key.uuidString, $0.value) },
            uniquingKeysWith: { a, _ in a }
        )
        groups = PhotoGrouping.autoGroup(groupables, hashes: hashes).compactMap { auto in
            let ids = auto.photoIds.compactMap(UUID.init(uuidString:))
            guard let cover = UUID(uuidString: auto.coverId) ?? ids.first else { return nil }
            return ReviewGroup(id: UUID(), photoIds: ids, coverId: cover)
        }
        // US-1909: auto-grouping assigns every photo, so nothing is left over.
        ungrouped = []
        // US-1548: regrouping mints fresh group ids — prior suggestions can no
        // longer be applied, so drop them (a new verify can re-derive).
        suggestions = []
        // US-1909: proposals were made against the previous grouping.
        proposalReviews = []
    }

    // MARK: - Edits

    func setCover(_ photoId: UUID, in groupId: UUID) {
        guard let gi = groups.firstIndex(where: { $0.id == groupId }),
              groups[gi].photoIds.contains(photoId) else { return }
        groups[gi].coverId = photoId
        // Keep the cover first so the listing hero is unambiguous.
        groups[gi].photoIds.removeAll { $0 == photoId }
        groups[gi].photoIds.insert(photoId, at: 0)
    }

    /// Move a photo to another group, or to a brand-new group when `target` is nil
    /// (split). Moving all of a group's photos into another effectively merges.
    func movePhoto(_ photoId: UUID, from sourceId: UUID, to targetId: UUID?) {
        guard let si = groups.firstIndex(where: { $0.id == sourceId }) else { return }
        groups[si].photoIds.removeAll { $0 == photoId }
        if let targetId, let ti = groups.firstIndex(where: { $0.id == targetId }) {
            groups[ti].photoIds.append(photoId)
        } else {
            groups.append(ReviewGroup(id: UUID(), photoIds: [photoId], coverId: photoId))
        }
        normalize()
    }

    func removePhoto(_ photoId: UUID) {
        forget(photoId)
        for i in groups.indices { groups[i].photoIds.removeAll { $0 == photoId } }
        normalize()
    }

    func deleteGroup(_ groupId: UUID) {
        guard let g = groups.first(where: { $0.id == groupId }) else { return }
        for pid in g.photoIds { forget(pid) }
        groups.removeAll { $0.id == groupId }
    }

    /// Drop every trace of a photo the seller discarded.
    private func forget(_ photoId: UUID) {
        photosById[photoId] = nil
        hashesById[photoId] = nil
        stagedPathByPhotoId[photoId] = nil
        timelessIds.remove(photoId)
        importOrder.removeAll { $0 == photoId }
        ungrouped.removeAll { $0 == photoId }
        proposalReviews = proposalReviews.compactMap { review in
            var next = review
            next.photoIds.removeAll { $0 == photoId.uuidString }
            return next.photoIds.count >= 2 ? next : nil
        }
    }

    // MARK: - US-1909: the ungrouped pool

    /// Pull a photo OUT of its group without discarding it — it lands in the
    /// ungrouped pool, where the seller can re-sort it or let "AI group
    /// remaining" propose a home for it.
    func ungroupPhoto(_ photoId: UUID, from groupId: UUID) {
        guard let gi = groups.firstIndex(where: { $0.id == groupId }),
              groups[gi].photoIds.contains(photoId) else { return }
        groups[gi].photoIds.removeAll { $0 == photoId }
        if !ungrouped.contains(photoId) { ungrouped.append(photoId) }
        normalize()
    }

    /// Move an ungrouped photo into a group, or into a brand-new one when
    /// `target` is nil.
    func groupUngroupedPhoto(_ photoId: UUID, into targetId: UUID?) {
        guard ungrouped.contains(photoId), photosById[photoId] != nil else { return }
        ungrouped.removeAll { $0 == photoId }
        if let targetId, let ti = groups.firstIndex(where: { $0.id == targetId }) {
            groups[ti].photoIds.append(photoId)
        } else {
            groups.append(ReviewGroup(id: UUID(), photoIds: [photoId], coverId: photoId))
        }
    }

    /// The ungrouped pool in the seller's chosen order. Every mode is a STABLE
    /// sort over the import order, so ties always fall back to it (mirrors the
    /// web grid, where `ungroupedSort === "upload"` recovers the original
    /// sequence exactly). Swift's `sorted(by:)` is NOT stable, so each mode
    /// decorates with the import index and breaks ties on it explicitly.
    var ungroupedSorted: [PhotoCapture] {
        // Anchor on importOrder, NOT the pool's own insertion order (which is
        // whatever sequence the seller happened to ungroup in) — that's what
        // makes `.upload` recover the original import sequence and every other
        // mode break ties on it.
        let pool = Set(ungrouped)
        let photos = importOrder.filter(pool.contains).compactMap { photosById[$0] }
        switch ungroupedSort {
        case .upload:
            return photos
        case .shooting:
            return stableSorted(photos) { a, b in
                PhotoGrouping.compareByProvenance(
                    capturedAt: self.effectiveCaptureDate(a),
                    sourceName: a.sourceName,
                    otherCapturedAt: self.effectiveCaptureDate(b),
                    otherSourceName: b.sourceName
                )
            }
        case .name:
            return stableSorted(photos) { a, b in
                // Natural compare so IMG_9 < IMG_10; unnamed photos sink to the end.
                switch (a.sourceName, b.sourceName) {
                case let (x?, y?):
                    let result = x.compare(y, options: [.numeric, .caseInsensitive])
                    return result == .orderedSame ? 0 : (result == .orderedAscending ? -1 : 1)
                case (_?, nil): return -1
                case (nil, _?): return 1
                case (nil, nil): return 0
                }
            }
        case .date:
            return stableSorted(photos) { a, b in
                // Photos with no real capture time sink to the end.
                switch (self.effectiveCaptureDate(a), self.effectiveCaptureDate(b)) {
                case let (x?, y?): return x == y ? 0 : (x < y ? -1 : 1)
                case (_?, nil): return -1
                case (nil, _?): return 1
                case (nil, nil): return 0
                }
            }
        }
    }

    /// The photo's REAL capture time — nil when `importPicks` had to fabricate
    /// one (see `timelessIds`).
    private func effectiveCaptureDate(_ photo: PhotoCapture) -> Date? {
        timelessIds.contains(photo.id) ? nil : photo.capturedAt
    }

    /// Stable sort: ties (comparator == 0) keep `photos`' incoming order, which
    /// is import order.
    private func stableSorted(
        _ photos: [PhotoCapture],
        by compare: (PhotoCapture, PhotoCapture) -> Int
    ) -> [PhotoCapture] {
        photos.enumerated()
            .sorted { a, b in
                let result = compare(a.element, b.element)
                return result == 0 ? a.offset < b.offset : result < 0
            }
            .map(\.element)
    }

    // MARK: - US-1548: AI group verification

    /// The silent post-import pass: only the FIRST window runs, so an automatic
    /// check stays cheap at one AI action. Any upload/verify failure just leaves
    /// the suggestions empty (advisory by design — no blocking UI).
    func verifyGroupsNow() async {
        await verifyGroups(silent: true)
    }

    /// US-1909: the EXPLICIT pass covers ALL groups. The /verify-groups endpoint
    /// samples each group to its boundary shots and packs groups into one
    /// request until a 40-photo budget is spent, so a big session used to get
    /// only its first ~13 groups checked. Walking every window fixes coverage —
    /// but each window is a metered AI action, so a >1-window pass asks first.
    func verifyAllGroups() async {
        await verifyGroups(silent: false)
    }

    private func verifyGroups(silent: Bool) async {
        guard groups.count >= 2, !verifying else { return }
        let payload = await buildVerifyPayload()
        guard payload.count >= 2 else {
            if silent { suggestions = [] }
            return
        }
        let windows = AutolisterWindows.planVerifyWindows(payload) { $0.photos.count }
        guard let first = windows.first else { return }
        if silent {
            await runVerifyWindows([first])
            return
        }
        if windows.count > 1 {
            // Show the metered count up front, before spending it.
            await refreshAiActionsRemaining()
            verifyConfirm = VerifyConfirm(windows: windows, totalGroups: payload.count)
            return
        }
        await runVerifyWindows(windows)
    }

    /// Run the windows the seller just confirmed.
    func confirmVerifyPass() async {
        guard let pending = verifyConfirm else { return }
        verifyConfirm = nil
        await runVerifyWindows(pending.windows)
    }

    /// Stage each group's boundary samples (once per session) and build the
    /// per-group payload. Groups whose samples couldn't upload are omitted.
    private func buildVerifyPayload() async -> [VerifyGroupPayload] {
        var uploads = stagedPathByPhotoId.count
        var payload: [VerifyGroupPayload] = []
        for group in groups {
            var photos: [VerifyGroupPhotoPayload] = []
            for pid in boundarySample(group.photoIds) {
                if stagedPathByPhotoId[pid] == nil {
                    guard uploads < Self.maxVerifyUploads,
                          let capture = photosById[pid] else { continue }
                    if let path = try? await service.stageVerificationPhoto(
                        sessionId: verifySessionId,
                        jpegData: capture.imageData
                    ) {
                        stagedPathByPhotoId[pid] = path
                        uploads += 1
                    }
                }
                if let path = stagedPathByPhotoId[pid] {
                    photos.append(
                        VerifyGroupPhotoPayload(id: pid.uuidString, storagePath: path)
                    )
                }
            }
            if !photos.isEmpty {
                payload.append(VerifyGroupPayload(id: group.id.uuidString, photos: photos))
            }
        }
        return payload
    }

    /// Walk the planned windows, aggregating + deduping suggestions across them.
    /// Cancellable between windows; a multi-window pass reports progress.
    private func runVerifyWindows(_ windows: [[VerifyGroupPayload]]) async {
        guard !windows.isEmpty else { return }
        let multi = windows.count > 1
        let totalGroups = windows.reduce(0) { $0 + $1.count }
        verifying = true
        passCancelled = false
        verifyProgress = multi ? PassProgress(done: 0, total: totalGroups) : nil
        defer {
            verifying = false
            verifyProgress = nil
        }

        var collected: [GroupVerifySuggestion] = []
        var anyError = false
        var done = 0
        for window in windows {
            if passCancelled { break }
            do {
                collected.append(contentsOf: try await service.verifyGroups(window).suggestions)
            } catch {
                anyError = true
            }
            done += window.count
            if multi { verifyProgress = PassProgress(done: done, total: totalGroups) }
        }

        let validGroupIds = Set(groups.map { $0.id.uuidString })
        let deduped = AutolisterWindows.dedupeSuggestions(collected).filter { s in
            s.groupIds.allSatisfy { validGroupIds.contains($0) }
        }
        // Don't clobber existing chips when the whole pass errored with nothing
        // to show; otherwise the fresh result (even empty) replaces them.
        if !(anyError && deduped.isEmpty) { suggestions = deduped }
    }

    /// Stop a multi-window pass after the in-flight window finishes.
    func cancelPass() {
        passCancelled = true
    }

    // MARK: - US-1909: AI propose-groups ("AI group remaining")

    /// Below this confidence a proposed boundary is surfaced for review rather
    /// than applied — the seller confirms it. Mirrors the web
    /// `PROPOSE_APPLY_FLOOR`.
    static let proposeApplyFloor = 0.6

    /// Window the ungrouped photos and ask the AI where each item begins — the
    /// signal that rescues a timeless dump auto-grouping can't split. A
    /// >1-window pass confirms the metered count first.
    func proposeGroupsNow() async {
        guard !proposing else { return }
        let ids = ungroupedSorted.map(\.id)
        guard ids.count >= 2 else { return }
        let windows = AutolisterWindows.planProposeWindows(ids.map(\.uuidString))
        guard !windows.isEmpty else { return }
        if windows.count > 1 {
            await refreshAiActionsRemaining()
            proposeConfirm = ProposeConfirm(windows: windows, photoCount: ids.count)
            return
        }
        await runProposeWindows(windows)
    }

    /// Run the propose windows the seller just confirmed.
    func confirmProposePass() async {
        guard let pending = proposeConfirm else { return }
        proposeConfirm = nil
        await runProposeWindows(pending.windows)
    }

    /// Walk the propose windows (which OVERLAP, so an item straddling a seam
    /// isn't force-split), stitch the per-window proposals back together, then
    /// apply the confident ones and surface the rest for review.
    private func runProposeWindows(_ windows: [[String]]) async {
        guard !windows.isEmpty else { return }
        let multi = windows.count > 1
        let totalPhotos = ungrouped.count
        proposing = true
        passCancelled = false
        proposeProgress = multi ? PassProgress(done: 0, total: totalPhotos) : nil
        defer {
            proposing = false
            proposeProgress = nil
        }

        var windowResults: [[ClientProposedGroup]] = []
        var done = 0
        for window in windows {
            if passCancelled { break }
            let photos = await stagedProposePayload(for: window)
            // Under two staged photos there's nothing to compare — the endpoint
            // would 400, so skip rather than burn the call.
            if photos.count >= 2, let response = try? await service.proposeGroups(photos) {
                windowResults.append(response.groups)
            }
            done += window.count
            if multi { proposeProgress = PassProgress(done: min(done, totalPhotos), total: totalPhotos) }
        }

        // A singleton stays a singleton; only multi-photo items are worth applying.
        let proposals = AutolisterWindows.mergeProposalWindows(windowResults)
            .filter { $0.photoIds.count >= 2 }
        guard !proposals.isEmpty else { return }
        let confident = proposals.filter { $0.confidence >= Self.proposeApplyFloor }
        applyProposedGroups(confident)
        proposalReviews.append(contentsOf: proposals.filter { $0.confidence < Self.proposeApplyFloor })
    }

    /// Stage (once per session) the window's photos and build the payload.
    private func stagedProposePayload(for window: [String]) async -> [ProposePhotoPayload] {
        var uploads = stagedPathByPhotoId.count
        var payload: [ProposePhotoPayload] = []
        for idString in window {
            guard let pid = UUID(uuidString: idString), let capture = photosById[pid] else { continue }
            if stagedPathByPhotoId[pid] == nil {
                guard uploads < Self.maxVerifyUploads else { continue }
                if let path = try? await service.stageVerificationPhoto(
                    sessionId: verifySessionId,
                    jpegData: capture.imageData
                ) {
                    stagedPathByPhotoId[pid] = path
                    uploads += 1
                }
            }
            if let path = stagedPathByPhotoId[pid] {
                payload.append(ProposePhotoPayload(id: idString, storagePath: path))
            }
        }
        return payload
    }

    /// Turn proposed photo-id runs into groups, for photos that are STILL
    /// ungrouped when applied (a proposal can race the seller's own edits).
    func applyProposedGroups(_ runs: [ClientProposedGroup]) {
        for run in runs {
            let ids = run.photoIds
                .compactMap(UUID.init(uuidString:))
                .filter { ungrouped.contains($0) }
            guard ids.count >= 2 else { continue }
            ungrouped.removeAll { ids.contains($0) }
            groups.append(ReviewGroup(id: UUID(), photoIds: ids, coverId: ids[0]))
        }
    }

    /// The seller accepted an uncertain proposal.
    func acceptProposalReview(_ review: ClientProposedGroup) {
        applyProposedGroups([review])
        dismissProposalReview(review)
    }

    func dismissProposalReview(_ review: ClientProposedGroup) {
        proposalReviews.removeAll { $0.id == review.id }
    }

    /// Test seam (US-1909): seed proposal reviews without a network pass.
    func applyTestProposalReviews(_ list: [ClientProposedGroup]) {
        proposalReviews = list
    }

    /// Load the remaining monthly AI actions so a metered confirm can show the
    /// real cost. Best-effort: a failed lookup leaves it nil and the dialog just
    /// omits the remaining count rather than blocking the pass.
    private func refreshAiActionsRemaining() async {
        let store = AIAssistantStore()
        await store.load()
        guard case let .ready(info) = store.phase else {
            aiActionsRemaining = nil
            return
        }
        aiActionsRemaining = max(
            0,
            AIAssistantStore.effectiveLimit(info) - info.ai_actions_used_this_month
        )
    }

    /// First / middle / last photo of a group — the frames most likely to
    /// reveal a bad boundary (mirrors the server's own sampling).
    private func boundarySample(_ ids: [UUID]) -> [UUID] {
        guard ids.count > 3 else { return ids }
        return [ids[0], ids[ids.count / 2], ids[ids.count - 1]]
    }

    /// Apply one suggestion through the SAME mutations the user's manual edits
    /// use (undo/normalize semantics identical), then drop it from the list.
    func applySuggestion(_ suggestion: GroupVerifySuggestion) {
        defer { dismissSuggestion(suggestion) }
        let gids = suggestion.groupIds.compactMap(UUID.init(uuidString:))
        let pids = suggestion.photoIds.compactMap(UUID.init(uuidString:))
        switch suggestion.type {
        case "merge":
            guard gids.count >= 2 else { return }
            mergeGroups(from: gids[1], into: gids[0])
        case "split":
            guard let source = gids.first, !pids.isEmpty else { return }
            splitPhotos(pids, from: source)
        case "move":
            guard gids.count >= 2, !pids.isEmpty else { return }
            for pid in pids { movePhoto(pid, from: gids[0], to: gids[1]) }
        default:
            break
        }
    }

    func dismissSuggestion(_ suggestion: GroupVerifySuggestion) {
        suggestions.removeAll { $0.id == suggestion.id }
    }

    /// Test seam (US-1548): seed suggestions without a network verify.
    func applyTestSuggestions(_ list: [GroupVerifySuggestion]) {
        suggestions = list
    }

    /// The suggestions relevant to one group card (for inline badges).
    func suggestions(for groupId: UUID) -> [GroupVerifySuggestion] {
        suggestions.filter { $0.groupIds.contains(groupId.uuidString) }
    }

    /// Move every photo of `from` into `into` (a merge), then normalize away
    /// the emptied group.
    func mergeGroups(from sourceId: UUID, into targetId: UUID) {
        guard let si = groups.firstIndex(where: { $0.id == sourceId }),
              groups.contains(where: { $0.id == targetId }) else { return }
        for pid in groups[si].photoIds {
            movePhoto(pid, from: sourceId, to: targetId)
        }
    }

    /// Split the given photos out of `sourceId` into ONE new group.
    func splitPhotos(_ photoIds: [UUID], from sourceId: UUID) {
        guard let si = groups.firstIndex(where: { $0.id == sourceId }) else { return }
        let members = photoIds.filter { groups[si].photoIds.contains($0) }
        guard let first = members.first else { return }
        movePhoto(first, from: sourceId, to: nil) // creates the new group
        guard let newGroup = groups.last, newGroup.photoIds == [first] else { return }
        for pid in members.dropFirst() {
            movePhoto(pid, from: sourceId, to: newGroup.id)
        }
    }

    /// Drop empty groups and repair any cover that no longer points at a member.
    private func normalize() {
        groups.removeAll { $0.photoIds.isEmpty }
        for i in groups.indices where !groups[i].photoIds.contains(groups[i].coverId) {
            if let first = groups[i].photoIds.first { groups[i].coverId = first }
        }
    }

    // MARK: - Rotate

    /// Rotates an imported photo 90° in place, BEFORE it's uploaded. Re-encodes
    /// the JPEG + thumbnail off-main and swaps the capture back under the same
    /// id, so grouping and cover selection are untouched — the rotated bytes are
    /// simply what Phase C uploads. We bake rotation into the pixels (not EXIF)
    /// because eBay's image pipeline ignores orientation tags (same rationale as
    /// `PhotoRotateService` for already-uploaded photos). No-op if the capture is
    /// missing or its data can't be decoded.
    func rotate(_ photoId: UUID, clockwise: Bool) async {
        guard let capture = photosById[photoId],
              let image = UIImage(data: capture.imageData) else {
            actionError = "Couldn't rotate that photo."
            return
        }
        let rotated = PhotoRotateService.rotated(image, clockwise: clockwise)
        guard let output = await PhotoCompressor.compressOffMain(rotated) else {
            actionError = "Couldn't rotate that photo. Try again."
            return
        }
        photosById[photoId] = PhotoCapture(
            id: capture.id,
            imageData: output.imageData,
            thumbnail: output.thumbnail,
            capturedAt: capture.capturedAt,
            source: capture.source,
            // US-1547: rotation must not drop the provenance filename.
            sourceName: capture.sourceName
        )
        // US-1548: re-hash the rotated pixels (a 90° turn changes the dHash).
        hashesById[photoId] = await Task.detached(priority: .userInitiated, operation: {
            DHash.compute(rotated)
        }).value
    }

    // MARK: - Handoff

    /// Snapshot for the generate pipeline: each group's photos ordered cover-first.
    func preparedGroups() -> [PreparedGroup] {
        groups.map { g in
            let ordered = ([g.coverId] + g.photoIds.filter { $0 != g.coverId })
                .compactMap { photosById[$0] }
            return PreparedGroup(coverId: g.coverId, photos: ordered)
        }
    }
}
