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
}
