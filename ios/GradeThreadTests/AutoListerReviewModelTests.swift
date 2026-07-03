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
