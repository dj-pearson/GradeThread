import XCTest
import UIKit
@testable import GradeThread

/// US-289: iOS photo-dump → reconcile-session handoff. Snapshot encoding (must
/// match the web ReconcileAssignmentSnapshot) + store orchestration.
@MainActor
final class ReconcileSessionTests: XCTestCase {

    // MARK: - Snapshot encoding

    func test_snapshotEntry_encodesCamelCaseKeysMatchingWeb() throws {
        let date = ISO8601DateFormatter().date(from: "2026-06-01T12:00:00Z")
        let entry = ReconcileSnapshotEntry(
            id: "p1", capturedAt: date, name: "p1.jpg", storagePath: "u/_reconcile/s/p1.jpg"
        )
        // supabase-swift encodes property names as-is (no key conversion), so
        // the JSONB keys must already be the camelCase the web board reads.
        let data = try JSONEncoder().encode(entry)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(obj["id"] as? String, "p1")
        XCTAssertEqual(obj["name"] as? String, "p1.jpg")
        XCTAssertEqual(obj["storagePath"] as? String, "u/_reconcile/s/p1.jpg")
        XCTAssertEqual(obj["photoType"] as? String, "detail")
        XCTAssertEqual(obj["manual"] as? Bool, false)
        XCTAssertTrue(obj["clusterId"] is NSNull)
        XCTAssertEqual(obj["capturedAt"] as? String, "2026-06-01T12:00:00Z")
    }

    func test_snapshotEntry_nilCapturedAtEncodesNull() throws {
        let entry = ReconcileSnapshotEntry(id: "p1", capturedAt: nil, name: "p1.jpg", storagePath: "x")
        let data = try JSONEncoder().encode(entry)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertTrue(obj["capturedAt"] is NSNull)
    }

    // MARK: - Store

    func test_store_syncUploadsAllAndSavesSnapshot() async {
        let fake = FakeReconcileIntake()
        let store = ReconcileIntakeStore(ownerId: "owner-1", service: fake)
        let captures = [makeCapture(), makeCapture()]
        let sessionId = await store.sync(captures)

        XCTAssertEqual(sessionId, "session-1")
        XCTAssertEqual(fake.createSessionCalls, ["owner-1"])
        XCTAssertEqual(fake.uploadCount, 2)
        XCTAssertEqual(fake.savedSnapshot?.count, 2)
        XCTAssertEqual(fake.savedPhotoCount, 2)
        // Each snapshot entry carries a storage path from the upload.
        XCTAssertTrue(fake.savedSnapshot?.allSatisfy { !$0.storagePath.isEmpty } ?? false)
        XCTAssertEqual(store.phase, .completed(count: 2))
    }

    func test_store_emptyInputIsNoOp() async {
        let fake = FakeReconcileIntake()
        let store = ReconcileIntakeStore(ownerId: "owner-1", service: fake)
        let result = await store.sync([])
        XCTAssertNil(result)
        XCTAssertEqual(fake.createSessionCalls.count, 0)
    }

    func test_store_uploadFailureSurfacesError() async {
        let fake = FakeReconcileIntake()
        fake.failUpload = true
        let store = ReconcileIntakeStore(ownerId: "owner-1", service: fake)
        let result = await store.sync([makeCapture()])
        XCTAssertNil(result)
        if case .failed = store.phase {} else { XCTFail("expected failed phase") }
        XCTAssertNil(fake.savedSnapshot)  // never reached save
    }

    // MARK: - Helpers

    private func makeCapture() -> PhotoCapture {
        let img = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { _ in }
        return PhotoCapture(
            imageData: img.jpegData(compressionQuality: 0.5) ?? Data([0xFF]),
            thumbnail: img,
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            source: .library
        )
    }

    final class FakeReconcileIntake: ReconcileIntakeProviding, @unchecked Sendable {
        var createSessionCalls: [String] = []
        var uploadCount = 0
        var savedSnapshot: [ReconcileSnapshotEntry]?
        var savedPhotoCount = 0
        var failUpload = false

        func createSession(ownerId: String) async throws -> String {
            createSessionCalls.append(ownerId)
            return "session-1"
        }

        func uploadStagedPhoto(ownerId: String, sessionId: String, photoId: String, jpeg: Data) async throws -> String {
            if failUpload {
                throw ReconcileIntakeService.ServiceError.uploadFailed(status: 500)
            }
            uploadCount += 1
            return "\(ownerId)/_reconcile/\(sessionId)/\(photoId).jpg"
        }

        func saveAssignments(sessionId: String, snapshot: [ReconcileSnapshotEntry], photoCount: Int) async throws {
            savedSnapshot = snapshot
            savedPhotoCount = photoCount
        }
    }
}
