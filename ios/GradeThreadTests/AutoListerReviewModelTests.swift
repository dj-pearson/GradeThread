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

    func test_ingest_groupsByCaptureTime() {
        let m = AutoListerReviewModel()
        m.ingest([cap(0), cap(5), cap(100)]) // burst of 2, then a lone shot
        XCTAssertEqual(m.groups.count, 2)
        XCTAssertEqual(m.totalPhotos, 3)
        XCTAssertTrue(m.canGenerate)
    }

    func test_empty_cannotGenerate() {
        XCTAssertFalse(AutoListerReviewModel().canGenerate)
    }

    func test_setCover_movesCoverToFront() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5)
        m.ingest([a, b])
        let g = m.groups[0]
        m.setCover(b.id, in: g.id)
        XCTAssertEqual(m.groups[0].coverId, b.id)
        XCTAssertEqual(m.groups[0].photoIds.first, b.id)
    }

    func test_split_movesPhotoToNewGroup() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5)
        m.ingest([a, b]) // one group
        m.movePhoto(b.id, from: m.groups[0].id, to: nil)
        XCTAssertEqual(m.groups.count, 2)
        XCTAssertEqual(m.totalPhotos, 2)
    }

    func test_merge_movingAllPhotosCollapsesGroup() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(100) // two separate groups
        m.ingest([a, b])
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
        m.setCover(a.id, in: m.groups[0].id)
        m.removePhoto(a.id) // removing the cover
        XCTAssertEqual(m.totalPhotos, 1)
        XCTAssertEqual(m.groups[0].coverId, b.id) // cover repaired to remaining photo
    }

    func test_removeLastPhoto_dropsGroup() {
        let m = AutoListerReviewModel()
        let a = cap(0)
        m.ingest([a])
        m.removePhoto(a.id)
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertFalse(m.canGenerate)
    }

    func test_deleteGroup_removesItsPhotos() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(100)
        m.ingest([a, b])
        m.deleteGroup(m.groups[0].id)
        XCTAssertEqual(m.groups.count, 1)
        XCTAssertEqual(m.totalPhotos, 1)
    }

    func test_preparedGroups_orderCoverFirst() {
        let m = AutoListerReviewModel()
        let a = cap(0), b = cap(5), c = cap(10)
        m.ingest([a, b, c]) // one group [a,b,c]
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
        await m.rotate(UUID(), clockwise: true) // unknown id
        XCTAssertEqual(m.totalPhotos, 1)
    }

    /// US-1116: a rotate that can't proceed surfaces a retryable error instead of
    /// silently doing nothing.
    func test_rotate_missingPhoto_surfacesActionError() async {
        let m = AutoListerReviewModel()
        m.ingest([landscapeCap()])
        await m.rotate(UUID(), clockwise: true)
        XCTAssertNotNil(m.actionError)
    }

    func test_hasPhotosButNoGroups_isFalseInNormalFlow() {
        let m = AutoListerReviewModel()
        XCTAssertFalse(m.hasPhotosButNoGroups) // empty
        m.ingest([cap(0)])
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
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        XCTAssertEqual(m.ungrouped, [a.id])
        XCTAssertEqual(m.totalPhotos, 2, "the photo is kept, just unassigned")
        XCTAssertEqual(m.groups[0].photoIds, [b.id])
    }

    func test_ungroupingAWholeGroup_dropsTheEmptyGroup_butKeepsThePhotos() {
        let a = cap(0)
        let m = AutoListerReviewModel()
        m.ingest([a])
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        XCTAssertTrue(m.groups.isEmpty)
        XCTAssertEqual(m.ungrouped, [a.id])
        XCTAssertFalse(m.hasPhotosButNoGroups, "an ungrouped pool is still reviewable")
    }

    func test_groupUngroupedPhoto_intoNewAndExistingGroups() {
        let a = cap(0), b = cap(500)
        let m = AutoListerReviewModel()
        m.ingest([a, b])
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
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        m.removePhoto(a.id)
        XCTAssertTrue(m.ungrouped.isEmpty)
        XCTAssertEqual(m.totalPhotos, 1)
    }

    func test_regroupAll_reclaimsTheUngroupedPool() {
        let a = cap(0), b = cap(5)
        let m = AutoListerReviewModel()
        m.ingest([a, b])
        m.ungroupPhoto(a.id, from: m.groups[0].id)
        m.regroupAll()
        XCTAssertTrue(m.ungrouped.isEmpty, "auto-grouping assigns every photo")
        XCTAssertEqual(m.groups.count, 1)
    }

    /// Ungroup everything so the pool ordering is what's under test.
    private func pooled(_ captures: [PhotoCapture], timeless: Bool = false) -> AutoListerReviewModel {
        let m = AutoListerReviewModel()
        if timeless { m.ingestTimeless(captures) } else { m.ingest(captures) }
        for group in m.groups {
            for pid in group.photoIds { m.ungroupPhoto(pid, from: group.id) }
        }
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
        for group in m.groups {
            for pid in group.photoIds { m.ungroupPhoto(pid, from: group.id) }
        }
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
}
