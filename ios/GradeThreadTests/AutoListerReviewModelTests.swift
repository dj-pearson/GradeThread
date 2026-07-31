import XCTest
import UIKit
@testable import GradeThread

/// Edit logic for the AutoLister review screen (`AutoListerReviewModel`): import
/// grouping, set-cover, split/merge moves, deletion, and the generate snapshot.
/// Seeds synthetic `PhotoCapture`s via the `ingest` test seam (no PhotoKit).
@MainActor
final class AutoListerReviewModelTests: XCTestCase {

    private let base = Date(timeIntervalSince1970: 1_000_000)

    private func cap(_ offset: TimeInterval) -> PhotoCapture {
        PhotoCapture(imageData: Data(), thumbnail: UIImage(),
                     capturedAt: base.addingTimeInterval(offset), source: .library)
    }

    /// US-2373: an import groups NOTHING on its own — every photo waits in the
    /// grid for the seller. Auto-group is a separate, explicit action.
    func test_ingest_leavesEveryPhotoUngrouped() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5), c = cap(100)
        m.ingest([a, b, c])
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertEqual(m.ungrouped, [a.id, b.id, c.id])
        XCTAssertEqual(m.totalPhotos, 3)
        XCTAssertFalse(m.canGenerate, "nothing is listable until something is grouped")
    }

    func test_autoGroupUngrouped_groupsByCaptureTime() {
        let m = AutoListerReviewModel()
        m.ingest([cap(0), cap(5), cap(100)]) // burst of 2, then a lone shot
        m.autoGroupUngrouped()
        XCTAssertEqual(m.groups.count, 2)
        XCTAssertEqual(m.totalPhotos, 3)
        XCTAssertTrue(m.ungrouped.isEmpty, "auto-group assigns every photo it sees")
        XCTAssertTrue(m.canGenerate)
    }

    /// Auto-group is a helper on the leftovers, never a bulldozer: it appends
    /// to what the seller already grouped by hand.
    func test_autoGroupUngrouped_keepsHandMadeGroups() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5), c = cap(500)
        m.ingest([a, b, c])
        m.toggleSelection(a.id)
        m.groupSelection()
        m.autoGroupUngrouped()
        XCTAssertEqual(m.groups[0].photoIds, [a.id], "the hand-made item is untouched")
        XCTAssertEqual(m.groups.count, 3, "b and c are far apart in time")
        XCTAssertTrue(m.ungrouped.isEmpty)
    }

    func test_empty_cannotGenerate() {
        XCTAssertFalse(AutoListerReviewModel().canGenerate)
    }

    // MARK: - Per-batch photo cap

    func test_capacity_startsAtMaxWhenEmpty() {
        let m = AutoListerReviewModel()
        XCTAssertEqual(m.remainingCapacity, AutoListerReviewModel.maxBatchPhotos)
        XCTAssertFalse(m.isAtCapacity)
    }

    func test_capacity_decrementsAsPhotosAreAdded() {
        let m = AutoListerReviewModel()
        m.ingest([cap(0), cap(5), cap(100)])
        m.autoGroupUngrouped()
        XCTAssertEqual(m.remainingCapacity, AutoListerReviewModel.maxBatchPhotos - 3)
        XCTAssertFalse(m.isAtCapacity)
    }

    func test_capacity_reportsFullAtMax() {
        let m = AutoListerReviewModel()
        m.ingest((0..<AutoListerReviewModel.maxBatchPhotos).map { cap(Double($0)) })
        m.autoGroupUngrouped()
        XCTAssertEqual(m.totalPhotos, AutoListerReviewModel.maxBatchPhotos)
        XCTAssertEqual(m.remainingCapacity, 0)
        XCTAssertTrue(m.isAtCapacity)
    }

    func test_setCover_movesCoverToFront() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5)
        m.ingest([a, b])
        m.autoGroupUngrouped()
        let g = m.groups[0]
        m.setCover(b.id, in: g.id)
        XCTAssertEqual(m.groups[0].coverId, b.id)
        XCTAssertEqual(m.groups[0].photoIds.first, b.id)
    }

    func test_split_movesPhotoToNewGroup() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5)
        m.ingest([a, b]) // one group
        m.autoGroupUngrouped()
        m.movePhoto(b.id, from: m.groups[0].id, to: nil)
        XCTAssertEqual(m.groups.count, 2)
        XCTAssertEqual(m.totalPhotos, 2)
    }

    func test_merge_movingAllPhotosCollapsesGroup() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(100) // two separate groups
        m.ingest([a, b])
        m.autoGroupUngrouped()
        XCTAssertEqual(m.groups.count, 2)
        let g1 = m.groups[0].id, g2 = m.groups[1].id
        m.movePhoto(b.id, from: g2, to: g1)
        XCTAssertEqual(m.groups.count, 1) // emptied source pruned
        XCTAssertEqual(Set(m.groups[0].photoIds), [a.id, b.id])
    }

    func test_removePhoto_prunesAndRepairsCover() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5)
        m.ingest([a, b])
        m.autoGroupUngrouped()
        m.setCover(a.id, in: m.groups[0].id)
        m.removePhoto(a.id) // removing the cover
        XCTAssertEqual(m.totalPhotos, 1)
        XCTAssertEqual(m.groups[0].coverId, b.id) // cover repaired to remaining photo
    }

    func test_removeLastPhoto_dropsGroup() {
        let m = AutoListerReviewModel()
        let a = cap(0)
        m.ingest([a])
        m.autoGroupUngrouped()
        m.removePhoto(a.id)
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertFalse(m.canGenerate)
    }

    func test_deleteGroup_removesItsPhotos() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(100)
        m.ingest([a, b])
        m.autoGroupUngrouped()
        m.deleteGroup(m.groups[0].id)
        XCTAssertEqual(m.groups.count, 1)
        XCTAssertEqual(m.totalPhotos, 1)
    }

    func test_preparedGroups_orderCoverFirst() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5), c = cap(10)
        m.ingest([a, b, c]) // one group [a,b,c]
        m.autoGroupUngrouped()
        m.setCover(c.id, in: m.groups[0].id)
        let prepared = m.preparedGroups()
        XCTAssertEqual(prepared.count, 1)
        XCTAssertEqual(prepared[0].coverId, c.id)
        XCTAssertEqual(prepared[0].photos.first?.id, c.id)
        XCTAssertEqual(prepared[0].photos.count, 3)
    }

    // MARK: - Rotate

    /// A real (non-square) capture so rotation actually has pixels to transform —
    /// the synthetic `cap()` helper has empty image data, which `rotate` no-ops.
    private func landscapeCap() -> PhotoCapture {
        let size = CGSize(width: 40, height: 20) // landscape
        let image = UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        return PhotoCapture(
            imageData: image.jpegData(compressionQuality: 0.8) ?? Data(),
            thumbnail: image,
            capturedAt: base,
            source: .library
        )
    }

    func test_rotate_keepsIdAndGroupingAndFlipsAspect() async {
        let m = AutoListerReviewModel()
        let p = landscapeCap()
        m.ingest([p])
        m.autoGroupUngrouped()
        let before = m.photos(in: m.groups[0]).first!
        XCTAssertGreaterThan(before.thumbnail.size.width, before.thumbnail.size.height) // landscape

        await m.rotate(p.id, clockwise: true)

        // Same id + still grouped — only the pixels changed.
        XCTAssertEqual(m.totalPhotos, 1)
        XCTAssertTrue(m.groups[0].photoIds.contains(p.id))
        let after = m.photos(in: m.groups[0]).first!
        XCTAssertEqual(after.id, p.id)
        XCTAssertGreaterThan(after.thumbnail.size.height, after.thumbnail.size.width) // now portrait
        XCTAssertNotEqual(after.imageData, before.imageData) // re-encoded rotated bytes
    }

    func test_rotate_missingPhoto_isNoOp() async {
        let m = AutoListerReviewModel()
        m.ingest([landscapeCap()])
        m.autoGroupUngrouped()
        await m.rotate(UUID(), clockwise: true) // unknown id
        XCTAssertEqual(m.totalPhotos, 1)
    }

    /// US-1116: a rotate that can't proceed surfaces a retryable error instead of
    /// silently doing nothing.
    func test_rotate_missingPhoto_surfacesActionError() async {
        let m = AutoListerReviewModel()
        m.ingest([landscapeCap()])
        m.autoGroupUngrouped()
        await m.rotate(UUID(), clockwise: true)
        XCTAssertNotNil(m.actionError)
    }

    func test_hasPhotosButNoGroups_isFalseInNormalFlow() {
        let m = AutoListerReviewModel()
        XCTAssertFalse(m.hasPhotosButNoGroups) // empty
        m.ingest([cap(0)])
        m.autoGroupUngrouped()
        XCTAssertFalse(m.hasPhotosButNoGroups) // grouped
    }

    // MARK: - US-1548: verify-groups suggestions

    /// In-memory service: no uploads (fixed paths), canned suggestions.
    private struct MockVerifyService: AutolisterBatching {
        let canned: [GroupVerifySuggestion]
        func startBatch(itemIds: [String], useComps: Bool, templateId: String?) async throws -> StartBatchResponse {
            throw URLError(.unsupportedURL)
        }
        func batchStatus(batchId: String) async throws -> BatchStatusResponse {
            throw URLError(.unsupportedURL)
        }
        func retryFailed(batchId: String) async throws -> RetryFailedResponse {
            throw URLError(.unsupportedURL)
        }
        func classifyPhotos(_ photos: [ClassifyPhotoInput]) async throws -> ClassifyPhotosResponse {
            throw URLError(.unsupportedURL)
        }
        func photoQa(itemIds: [String]) async throws -> PhotoQaResponse {
            throw URLError(.unsupportedURL)
        }
        func stageVerificationPhoto(sessionId: String, jpegData: Data) async throws -> String {
            "owner/_staging/mock/\(UUID().uuidString).jpg"
        }
        func verifyGroups(_ groups: [VerifyGroupPayload]) async throws -> VerifyGroupsResponse {
            VerifyGroupsResponse(suggestions: canned)
        }
    }

    private struct FailingVerifyService: AutolisterBatching {
        func startBatch(itemIds: [String], useComps: Bool, templateId: String?) async throws -> StartBatchResponse {
            throw URLError(.unsupportedURL)
        }
        func batchStatus(batchId: String) async throws -> BatchStatusResponse {
            throw URLError(.unsupportedURL)
        }
        func retryFailed(batchId: String) async throws -> RetryFailedResponse {
            throw URLError(.unsupportedURL)
        }
        func classifyPhotos(_ photos: [ClassifyPhotoInput]) async throws -> ClassifyPhotosResponse {
            throw URLError(.unsupportedURL)
        }
        func photoQa(itemIds: [String]) async throws -> PhotoQaResponse {
            throw URLError(.unsupportedURL)
        }
        func stageVerificationPhoto(sessionId: String, jpegData: Data) async throws -> String {
            throw URLError(.timedOut)
        }
        func verifyGroups(_ groups: [VerifyGroupPayload]) async throws -> VerifyGroupsResponse {
            throw URLError(.timedOut)
        }
    }

    func test_verify_appliesMergeSuggestionThroughNormalMutations() async {
        // Two time-separated groups the AI says are the same item.
        let a = cap(0), b = cap(500)
        let probe = AutoListerReviewModel()
        probe.ingest([a, b])
        probe.autoGroupUngrouped()
        let ga = probe.groups[0].id, gb = probe.groups[1].id
        let merge = GroupVerifySuggestion(
            type: "merge",
            groupIds: [ga.uuidString, gb.uuidString],
            photoIds: [],
            confidence: 0.9,
            reason: "Same jacket across both groups"
        )
        // Re-seed a model whose service returns that suggestion for ITS ids —
        // easier: drive apply directly on the probe.
        probe.applyTestSuggestions([merge])
        XCTAssertEqual(probe.suggestions.count, 1)
        probe.applySuggestion(merge)
        XCTAssertEqual(probe.groups.count, 1)
        XCTAssertEqual(Set(probe.groups[0].photoIds), [a.id, b.id])
        XCTAssertTrue(probe.suggestions.isEmpty, "applied suggestion is dismissed")
    }

    func test_verify_splitSuggestionCreatesOneNewGroup() {
        let a = cap(0), b = cap(2), c = cap(4)
        let m = AutoListerReviewModel()
        m.ingest([a, b, c]) // one burst group
        m.autoGroupUngrouped()
        let g = m.groups[0].id
        let split = GroupVerifySuggestion(
            type: "split",
            groupIds: [g.uuidString],
            photoIds: [b.id.uuidString, c.id.uuidString],
            confidence: 0.8,
            reason: "Photos 2-3 show a different item"
        )
        m.applyTestSuggestions([split])
        m.applySuggestion(split)
        XCTAssertEqual(m.groups.count, 2)
        XCTAssertEqual(m.groups[0].photoIds, [a.id])
        XCTAssertEqual(Set(m.groups[1].photoIds), [b.id, c.id])
    }

    func test_verify_silentDegradeOnFailure() async {
        let m = AutoListerReviewModel(service: FailingVerifyService())
        m.ingest([cap(0), cap(500)]) // two groups
        m.autoGroupUngrouped()
        await m.verifyGroupsNow()
        XCTAssertTrue(m.suggestions.isEmpty)
        XCTAssertNil(m.actionError, "verification failures are silent")
    }

    func test_verify_endToEndWithMockService_filtersUnknownGroupIds() async {
        let a = cap(0), b = cap(500)
        // Canned suggestions reference a FOREIGN group id → filtered out.
        let foreign = GroupVerifySuggestion(
            type: "merge",
            groupIds: [UUID().uuidString, UUID().uuidString],
            photoIds: [],
            confidence: 0.9,
            reason: "stale"
        )
        let m = AutoListerReviewModel(service: MockVerifyService(canned: [foreign]))
        m.ingest([a, b])
        m.autoGroupUngrouped()
        await m.verifyGroupsNow()
        XCTAssertTrue(m.suggestions.isEmpty, "suggestions for unknown groups are dropped")
    }

    // MARK: - US-1909: ungrouped pool + sort modes

    private func named(_ name: String?, _ offset: TimeInterval) -> PhotoCapture {
        PhotoCapture(imageData: Data(), thumbnail: UIImage(),
                     capturedAt: base.addingTimeInterval(offset), source: .library,
                     sourceName: name)
    }

    func test_ungroupPhoto_movesItToThePool_withoutDiscardingIt() {
        let a = cap(0), b = cap(5)
        let m = AutoListerReviewModel()
        m.ingest([a, b])
        m.autoGroupUngrouped()
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        XCTAssertEqual(m.ungrouped, [a.id])
        XCTAssertEqual(m.totalPhotos, 2, "the photo is kept, just unassigned")
        XCTAssertEqual(m.groups[0].photoIds, [b.id])
    }

    func test_ungroupingAWholeGroup_dropsTheEmptyGroup_butKeepsThePhotos() {
        let a = cap(0)
        let m = AutoListerReviewModel()
        m.ingest([a])
        m.autoGroupUngrouped()
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertEqual(m.ungrouped, [a.id])
        XCTAssertFalse(m.hasPhotosButNoGroups, "an ungrouped pool is still reviewable")
    }

    func test_groupUngroupedPhoto_intoNewAndExistingGroups() {
        let a = cap(0), b = cap(500)
        let m = AutoListerReviewModel()
        m.ingest([a, b])
        m.autoGroupUngrouped()
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        XCTAssertEqual(m.groups.count, 1)

        m.groupUngroupedPhoto(a.id, into: m.groups[0].id)
        XCTAssertTrue(m.ungrouped.isEmpty)
        XCTAssertEqual(Set(m.groups[0].photoIds), [a.id, b.id])
    }

    func test_removePhoto_alsoClearsItFromThePool() {
        let a = cap(0), b = cap(5)
        let m = AutoListerReviewModel()
        m.ingest([a, b])
        m.autoGroupUngrouped()
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        m.removePhoto(a.id)
        XCTAssertTrue(m.ungrouped.isEmpty)
        XCTAssertEqual(m.totalPhotos, 1)
    }

    func test_regroupAll_reclaimsTheUngroupedPool() {
        let a = cap(0), b = cap(5)
        let m = AutoListerReviewModel()
        m.ingest([a, b])
        m.autoGroupUngrouped()
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        m.regroupAll()
        XCTAssertTrue(m.ungrouped.isEmpty, "auto-grouping assigns every photo")
        XCTAssertEqual(m.groups.count, 1)
    }

    /// US-2373: an import already leaves everything in the pool, which is what
    /// the ordering tests below are about.
    private func pooled(_ captures: [PhotoCapture], timeless: Bool = false) -> AutoListerReviewModel {
        let m = AutoListerReviewModel()
        if timeless { m.ingestTimeless(captures) } else { m.ingest(captures) }
        return m
    }

    func test_ungroupedSort_uploadModeKeepsImportOrder() {
        let a = named("IMG_0009.jpg", 100), b = named("IMG_0002.jpg", 0)
        let m = pooled([a, b])
        m.ungroupedSort = .upload
        XCTAssertEqual(m.ungroupedSorted.map(\.id), [a.id, b.id])
    }

    func test_ungroupedSort_dateModeOrdersByCaptureTime() {
        let a = named("IMG_0009.jpg", 100), b = named("IMG_0002.jpg", 0)
        let m = pooled([a, b])
        m.ungroupedSort = .date
        XCTAssertEqual(m.ungroupedSorted.map(\.id), [b.id, a.id])
    }

    func test_ungroupedSort_nameModeIsNaturalAndSinksUnnamed() {
        // Natural compare: IMG_9 before IMG_10 (a lexical sort would invert it).
        let nine = named("IMG_9.jpg", 0)
        let ten = named("IMG_10.jpg", 10)
        let unnamed = named(nil, 20)
        let m = pooled([unnamed, ten, nine])
        m.ungroupedSort = .name
        XCTAssertEqual(m.ungroupedSorted.map(\.id), [nine.id, ten.id, unnamed.id])
    }

    func test_ungroupedSort_shootingModeUsesTimeThenFilename() {
        // Timeless photos: the filename sequence orders them, not import order.
        let c = named("IMG_0003.jpg", 0)
        let a = named("IMG_0001.jpg", 0)
        let b = named("IMG_0002.jpg", 0)
        let m = pooled([c, a, b], timeless: true)
        m.ungroupedSort = .shooting
        XCTAssertEqual(m.ungroupedSorted.map(\.id), [a.id, b.id, c.id])
    }

    func test_ungroupedSort_shootingModeTiesFallBackToImportOrder() {
        // Neither name parses and both are timeless → a tie the stable sort
        // resolves to import order.
        let x = named("front.jpg", 0), y = named("back.jpg", 0)
        let m = pooled([x, y], timeless: true)
        m.ungroupedSort = .shooting
        XCTAssertEqual(m.ungroupedSorted.map(\.id), [x.id, y.id])
    }

    // MARK: - US-1909: propose-groups

    func test_applyProposedGroups_onlyGroupsPhotosStillUngrouped() {
        let a = cap(0), b = cap(500), c = cap(1000)
        let m = AutoListerReviewModel()
        m.ingest([a, b, c])
        // `c` is claimed by the seller before the proposal is applied.
        m.groupUngroupedPhoto(c.id, into: nil)

        m.applyProposedGroups([
            ClientProposedGroup(
                photoIds: [a.id, b.id, c.id].map(\.uuidString), confidence: 0.9, reason: "r"
            ),
        ])
        // Only a+b are grouped by the proposal; c keeps its own group.
        XCTAssertTrue(m.ungrouped.isEmpty)
        XCTAssertEqual(m.groups.count, 2)
        XCTAssertEqual(Set(m.groups[1].photoIds), [a.id, b.id])
    }

    func test_applyProposedGroups_ignoresASingletonProposal() {
        let a = cap(0)
        let m = pooled([a])
        m.applyProposedGroups([
            ClientProposedGroup(photoIds: [a.id.uuidString], confidence: 0.9, reason: "r"),
        ])
        XCTAssertTrue(m.groups.isEmpty, "a one-photo proposal is not an item boundary")
        XCTAssertEqual(m.ungrouped, [a.id])
    }

    func test_proposalReview_acceptCreatesTheGroup_dismissDoesNot() {
        let a = cap(0), b = cap(500)
        let m = pooled([a, b])
        let review = ClientProposedGroup(
            photoIds: [a.id, b.id].map(\.uuidString), confidence: 0.4, reason: "unsure"
        )
        m.applyTestProposalReviews([review])
        m.dismissProposalReview(review)
        XCTAssertTrue(m.proposalReviews.isEmpty)
        XCTAssertTrue(m.groups.isEmpty, "a dismissed proposal creates nothing")

        m.applyTestProposalReviews([review])
        m.acceptProposalReview(review)
        XCTAssertTrue(m.proposalReviews.isEmpty)
        XCTAssertEqual(Set(m.groups[0].photoIds), [a.id, b.id])
    }

    func test_regroup_clearsStaleSuggestions() {
        let m = AutoListerReviewModel()
        m.ingest([cap(0), cap(500)])
        m.autoGroupUngrouped()
        m.applyTestSuggestions([
            GroupVerifySuggestion(
                type: "merge",
                groupIds: [m.groups[0].id.uuidString, m.groups[1].id.uuidString],
                photoIds: [],
                confidence: 0.9,
                reason: "x"
            ),
        ])
        m.regroupAll()
        XCTAssertTrue(m.suggestions.isEmpty)
    }

    // MARK: - US-2373: selection-driven grouping

    func test_groupSelection_makesOneItemAndClearsThoseTilesFromTheGrid() {
        let a = named("IMG_0001.jpg", 0)
        let b = named("IMG_0002.jpg", 5)
        let c = named("IMG_0003.jpg", 10)
        let m = pooled([a, b, c])
        m.toggleSelection(a.id)
        m.toggleSelection(b.id)
        XCTAssertEqual(m.selectedCount, 2)

        XCTAssertTrue(m.groupSelection())
        XCTAssertEqual(m.groups.count, 1)
        XCTAssertEqual(m.groups[0].photoIds, [a.id, b.id])
        XCTAssertEqual(m.groups[0].coverId, a.id, "the first photo shown covers the item")
        XCTAssertEqual(m.ungrouped, [c.id], "grouped photos leave the grid")
        XCTAssertFalse(m.hasSelection, "the next item starts from a clean selection")
    }

    /// The group keeps the order the grid is SHOWING, not the order of taps —
    /// otherwise a range select would produce a scrambled photo order.
    func test_groupSelection_ordersByTheGridsCurrentSort() {
        let a = named("IMG_0001.jpg", 0)
        let b = named("IMG_0002.jpg", 5)
        let m = pooled([b, a]) // imported out of name order
        m.ungroupedSort = .name
        m.toggleSelection(b.id)
        m.toggleSelection(a.id) // tapped second, but shown first
        m.groupSelection()
        XCTAssertEqual(m.groups[0].photoIds, [a.id, b.id])
    }

    func test_groupSelection_withNothingSelectedDoesNothing() {
        let m = pooled([cap(0)])
        XCTAssertFalse(m.groupSelection())
        XCTAssertTrue(m.groups.isEmpty)
    }

    func test_toggleSelection_isATapOnAndATapOff() {
        let a = cap(0)
        let m = pooled([a])
        m.toggleSelection(a.id)
        XCTAssertTrue(m.isSelected(a.id))
        m.toggleSelection(a.id)
        XCTAssertFalse(m.isSelected(a.id))
    }

    func test_selectRange_selectsEverythingBetweenTheTwoTaps_inGridOrder() {
        let photos = (0..<5).map { named("IMG_000\($0).jpg", Double($0)) }
        let m = pooled(photos)
        m.ungroupedSort = .name
        m.toggleSelection(photos[1].id)
        m.selectRange(through: photos[3].id)
        XCTAssertEqual(m.selectedCount, 3)
        XCTAssertEqual(
            Set([photos[1].id, photos[2].id, photos[3].id]),
            m.selection
        )
    }

    /// A range with no anchor yet is just a normal tap — never a silent
    /// select-everything.
    func test_selectRange_withoutAnAnchorSelectsOnlyThatPhoto() {
        let photos = (0..<3).map { cap(Double($0) * 100) }
        let m = pooled(photos)
        m.selectRange(through: photos[2].id)
        XCTAssertEqual(m.selection, [photos[2].id])
    }

    func test_selectAllAndClear() {
        let photos = (0..<4).map { cap(Double($0)) }
        let m = pooled(photos)
        m.selectAllUngrouped()
        XCTAssertEqual(m.selectedCount, 4)
        m.clearSelection()
        XCTAssertEqual(m.selectedCount, 0)
    }

    func test_selectionNeverIncludesAnAlreadyGroupedPhoto() {
        let a = cap(0), b = cap(5)
        let m = pooled([a, b])
        m.toggleSelection(a.id)
        m.groupSelection()
        m.toggleSelection(a.id) // a now lives in an item, not the grid
        XCTAssertFalse(m.isSelected(a.id))
    }

    func test_groupEveryN_cutsTheGridIntoFixedSizeItemsInTheOrderShown() {
        let photos = (0..<5).map { named("IMG_000\($0).jpg", Double($0)) }
        let m = pooled(photos)
        m.ungroupedSort = .name
        XCTAssertEqual(m.groupEveryN(2), 3, "5 photos → 2 + 2 + 1")
        XCTAssertEqual(m.groups[0].photoIds, [photos[0].id, photos[1].id])
        XCTAssertEqual(m.groups[2].photoIds, [photos[4].id])
        XCTAssertTrue(m.ungrouped.isEmpty)
    }

    func test_groupEveryN_rejectsAZeroSize() {
        let m = pooled([cap(0), cap(5)])
        XCTAssertEqual(m.groupEveryN(0), 0)
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertEqual(m.ungroupedCount, 2)
    }

    func test_ungroupGroup_returnsEveryPhotoToTheGridInImportOrder() {
        let a = cap(0), b = cap(5), c = cap(10)
        let m = pooled([a, b, c])
        m.toggleSelection(b.id)
        m.groupSelection()
        XCTAssertEqual(m.ungrouped, [a.id, c.id])

        m.ungroupGroup(m.groups[0].id)
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertEqual(m.ungrouped, [a.id, b.id, c.id], "back where it came from")
        XCTAssertEqual(m.totalPhotos, 3, "ungrouping discards nothing")
    }

    func test_removeSelected_discardsThemEverywhere() {
        let a = cap(0), b = cap(5), c = cap(10)
        let m = pooled([a, b, c])
        m.toggleSelection(a.id)
        m.toggleSelection(b.id)
        XCTAssertEqual(m.removeSelected(), 2)
        XCTAssertEqual(m.totalPhotos, 1)
        XCTAssertEqual(m.ungrouped, [c.id])
        XCTAssertFalse(m.hasSelection)
    }

    func test_gridCaption_showsWhateverTheGridIsSortedBy() {
        let photo = named("IMG_0042.jpg", 0)
        let m = pooled([photo])
        m.ungroupedSort = .name
        XCTAssertEqual(m.gridCaption(for: photo), "IMG_0042.jpg")
        m.ungroupedSort = .date
        XCTAssertNotEqual(m.gridCaption(for: photo), "IMG_0042.jpg", "a real capture time wins")
        XCTAssertNotNil(m.gridCaption(for: photo))
    }

    func test_gridCaption_fallsBackToTheFileNameWhenThereIsNoRealCaptureTime() {
        let photo = named("IMG_0042.jpg", 0)
        let m = pooled([photo], timeless: true)
        m.ungroupedSort = .date
        XCTAssertEqual(m.gridCaption(for: photo), "IMG_0042.jpg")
    }

    func test_gridCaption_isNilWhenThePhotoCarriesNoProvenance() {
        let anonymous = named(nil, 0)
        let m = pooled([anonymous], timeless: true)
        m.ungroupedSort = .name
        XCTAssertNil(m.gridCaption(for: anonymous))
    }

    func test_importProgress_fractionIsSafeAtZeroTotal() {
        XCTAssertEqual(AutoListerReviewModel.ImportProgress(done: 0, total: 0).fraction, 0)
        XCTAssertEqual(AutoListerReviewModel.ImportProgress(done: 50, total: 200).fraction, 0.25)
    }

    // MARK: - US-2374: send to desktop

    /// Records what the handoff actually put on the wire, and can fail chosen
    /// uploads so the partial path is exercised.
    private final class RecordingHandoffService: AutolisterBatching, @unchecked Sendable {
        /// Upload indexes (0-based) that should throw.
        var failUploadsAt: Set<Int> = []
        private(set) var uploadCount = 0
        private(set) var stagingSessionIds: [String] = []
        private(set) var sentPhotos: [HandoffPhotoPayload] = []
        private(set) var sentGroups: [HandoffGroupPayload] = []
        private(set) var sessionCreated = false

        func startBatch(itemIds: [String], useComps: Bool, templateId: String?) async throws -> StartBatchResponse {
            throw URLError(.unsupportedURL)
        }
        func batchStatus(batchId: String) async throws -> BatchStatusResponse {
            throw URLError(.unsupportedURL)
        }
        func retryFailed(batchId: String) async throws -> RetryFailedResponse {
            throw URLError(.unsupportedURL)
        }
        func classifyPhotos(_ photos: [ClassifyPhotoInput]) async throws -> ClassifyPhotosResponse {
            throw URLError(.unsupportedURL)
        }
        func photoQa(itemIds: [String]) async throws -> PhotoQaResponse {
            throw URLError(.unsupportedURL)
        }
        func stagePhoto(
            sessionId: String,
            jpegData: Data,
            thumbnailData: Data?
        ) async throws -> StagedPhotoUpload {
            defer { uploadCount += 1 }
            stagingSessionIds.append(sessionId)
            if failUploadsAt.contains(uploadCount) { throw URLError(.timedOut) }
            return StagedPhotoUpload(
                storagePath: "owner/_staging/\(sessionId)/\(uploadCount).jpg",
                url: "https://example.test/\(uploadCount).jpg",
                thumbnailStoragePath: "owner/_staging/\(sessionId)/\(uploadCount)_thumb.jpg",
                thumbnailUrl: "https://example.test/\(uploadCount)_thumb.jpg",
                width: 1600,
                height: 1200,
                bytes: 450_000
            )
        }
        func createHandoffSession(
            stagingSessionId: String,
            photos: [HandoffPhotoPayload],
            groups: [HandoffGroupPayload]
        ) async throws -> HandoffSessionResponse {
            sessionCreated = true
            sentPhotos = photos
            sentGroups = groups
            return HandoffSessionResponse(
                id: UUID().uuidString,
                photoCount: photos.count,
                groupCount: groups.count
            )
        }
    }

    func test_sendToDesktop_uploadsEveryPhotoAndSendsTheGrouping() async {
        let service = RecordingHandoffService()
        let m = AutoListerReviewModel(service: service)
        let a = cap(0), b = cap(5), c = cap(500)
        m.ingest([a, b, c])
        m.toggleSelection(a.id)
        m.toggleSelection(b.id)
        m.groupSelection()

        await m.sendToDesktop()

        XCTAssertEqual(service.uploadCount, 3, "ungrouped photos travel too")
        XCTAssertEqual(service.sentPhotos.count, 3)
        XCTAssertEqual(service.sentGroups.count, 1)
        XCTAssertEqual(service.sentGroups[0].photoIds, [a.id.uuidString, b.id.uuidString])
        XCTAssertEqual(service.sentGroups[0].coverId, a.id.uuidString)
        XCTAssertEqual(m.handoff, .sent(photos: 3, partial: false))
        // One staging folder for the whole batch — that's what the desktop
        // sweeps when the seller discards it.
        XCTAssertEqual(Set(service.stagingSessionIds).count, 1)
    }

    /// A fabricated capture time must NOT travel: the desktop's auto-grouping
    /// would read it as one instantaneous burst, the exact trap US-1909 fixed
    /// on this side.
    func test_sendToDesktop_sendsNoCaptureTimeForTimelessPhotos() async {
        let service = RecordingHandoffService()
        let m = AutoListerReviewModel(service: service)
        let timeless = named("IMG_0001.jpg", 0)
        m.ingestTimeless([timeless])
        await m.sendToDesktop()
        XCTAssertEqual(service.sentPhotos.count, 1)
        XCTAssertNil(service.sentPhotos[0].capturedAtMs)
        XCTAssertEqual(service.sentPhotos[0].sourceName, "IMG_0001.jpg")

        let timed = AutoListerReviewModel(service: RecordingHandoffService())
        timed.ingest([cap(0)])
        await timed.sendToDesktop()
        XCTAssertEqual(timed.handoff, .sent(photos: 1, partial: false))
    }

    func test_sendToDesktop_oneFailedUploadStillSendsTheRest() async {
        let service = RecordingHandoffService()
        service.failUploadsAt = [1]
        let m = AutoListerReviewModel(service: service)
        let a = cap(0), b = cap(5), c = cap(10)
        m.ingest([a, b, c])
        m.selectAllUngrouped()
        m.groupSelection()

        await m.sendToDesktop()

        XCTAssertEqual(service.sentPhotos.count, 2, "the failed photo is dropped, not the batch")
        XCTAssertEqual(m.handoff, .sent(photos: 2, partial: true))
        XCTAssertEqual(
            service.sentGroups[0].photoIds.count, 2,
            "the group travels without the photo that didn't upload"
        )
    }

    func test_sendToDesktop_everyUploadFailing_reportsFailureAndSendsNothing() async {
        let service = RecordingHandoffService()
        service.failUploadsAt = [0]
        let m = AutoListerReviewModel(service: service)
        m.ingest([cap(0)])

        await m.sendToDesktop()

        XCTAssertFalse(service.sessionCreated, "no session is parked for zero photos")
        guard case .failed = m.handoff else {
            return XCTFail("expected a failed handoff, got \(m.handoff)")
        }
    }

    func test_clearBatch_emptiesEverythingSoTheBatchIsNotGeneratedTwice() async {
        let service = RecordingHandoffService()
        let m = AutoListerReviewModel(service: service)
        let a = cap(0), b = cap(5)
        m.ingest([a, b])
        m.selectAllUngrouped()
        m.groupSelection()
        await m.sendToDesktop()

        m.clearBatch()
        XCTAssertTrue(m.isEmpty)
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertTrue(m.ungrouped.isEmpty)
        XCTAssertFalse(m.canGenerate)
        XCTAssertEqual(m.handoff, .idle)
    }

    /// Generating is gated on there being at least one item — ungrouped photos
    /// don't block it (the bar warns instead), but they don't enable it either.
    func test_canGenerate_needsAtLeastOneGroup() {
        let a = cap(0)
        let m = pooled([a])
        XCTAssertFalse(m.canGenerate)
        m.toggleSelection(a.id)
        m.groupSelection()
        XCTAssertTrue(m.canGenerate)
    }
}
