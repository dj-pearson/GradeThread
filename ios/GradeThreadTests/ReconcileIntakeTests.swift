import XCTest
import UIKit
@testable import GradeThread

/// US-289 — Photo Dump Reconciliation intake plumbing on iOS.
///
/// These cover the pure, deterministic pieces of the reconcile upload path:
/// the `item_photos` row shape (captured_at + reconcile_session_id) and that
/// the upload task carries the original capture time and session id through.
/// PHAsset/PHPicker creation-date reading and the live upload are exercised on
/// device; here we lock down the data contract the web reconcile board relies on.
final class ReconcileIntakeTests: XCTestCase {

    private func encodeToObject(_ row: ItemPhotoInsert) throws -> [String: Any] {
        let data = try JSONEncoder().encode(row)
        let obj = try JSONSerialization.jsonObject(with: data)
        return obj as? [String: Any] ?? [:]
    }

    private func base(
        capturedAt: Date? = nil,
        session: String? = nil
    ) -> ItemPhotoInsert {
        ItemPhotoInsert(
            id: "11111111-1111-1111-1111-111111111111",
            inventory_item_id: "item-1",
            photo_type: "front",
            storage_path: "user-1/item-1/front_0.jpg",
            photo_url: "https://example.test/front.jpg",
            sort_order: 2,
            bytes: 4096,
            captured_at: capturedAt,
            reconcile_session_id: session
        )
    }

    func test_itemPhotoInsert_alwaysEncodesBaseFields() throws {
        let json = try encodeToObject(base())
        XCTAssertEqual(json["id"] as? String, "11111111-1111-1111-1111-111111111111")
        XCTAssertEqual(json["inventory_item_id"] as? String, "item-1")
        XCTAssertEqual(json["photo_type"] as? String, "front")
        XCTAssertEqual(json["storage_path"] as? String, "user-1/item-1/front_0.jpg")
        XCTAssertEqual(json["photo_url"] as? String, "https://example.test/front.jpg")
        XCTAssertEqual(json["sort_order"] as? Int, 2)
        XCTAssertEqual(json["bytes"] as? Int, 4096)
    }

    func test_itemPhotoInsert_omitsOptionalsWhenNil() throws {
        // Non-reconcile single-item uploads must not start writing these keys.
        let json = try encodeToObject(base(capturedAt: nil, session: nil))
        XCTAssertNil(json["captured_at"])
        XCTAssertNil(json["reconcile_session_id"])
    }

    func test_itemPhotoInsert_encodesReconcileSessionId() throws {
        let json = try encodeToObject(base(session: "sess-abc"))
        XCTAssertEqual(json["reconcile_session_id"] as? String, "sess-abc")
    }

    func test_itemPhotoInsert_encodesCapturedAtAsISO8601() throws {
        // 2021-07-15T14:30:00Z
        let date = Date(timeIntervalSince1970: 1_626_359_400)
        let json = try encodeToObject(base(capturedAt: date))
        let str = try XCTUnwrap(json["captured_at"] as? String)
        XCTAssertEqual(str, "2021-07-15T14:30:00Z")
        // Round-trips back to the same instant.
        let parsed = try XCTUnwrap(ItemPhotoInsert.captureFormatter.date(from: str))
        XCTAssertEqual(parsed.timeIntervalSince1970, date.timeIntervalSince1970, accuracy: 1)
    }

    func test_photoUploadTask_carriesCapturedAtAndSessionId() {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let task = PhotoUploadTask(
            inventoryItemId: "item-1",
            userId: "user-1",
            slot: .front,
            storagePath: "user-1/item-1/front_0.jpg",
            localFileURL: URL(fileURLWithPath: "/tmp/x.jpg"),
            bytes: 1,
            capturedAt: date,
            reconcileSessionId: "sess-xyz"
        )
        XCTAssertEqual(task.capturedAt, date)
        XCTAssertEqual(task.reconcileSessionId, "sess-xyz")
    }

    func test_photoUploadTask_defaultsOptionalsToNil() {
        let task = PhotoUploadTask(
            inventoryItemId: "item-1",
            userId: "user-1",
            slot: .front,
            storagePath: "user-1/item-1/front_0.jpg",
            localFileURL: URL(fileURLWithPath: "/tmp/x.jpg"),
            bytes: 1
        )
        XCTAssertNil(task.capturedAt)
        XCTAssertNil(task.reconcileSessionId)
    }

    func test_photoCapture_capturedAt_isPreserved() {
        // The library-pick path threads PHAsset.creationDate into capturedAt;
        // confirm the model holds whatever capture time it's given.
        let date = Date(timeIntervalSince1970: 1_600_000_000)
        let capture = PhotoCapture(
            imageData: Data([0xFF, 0xD8, 0xFF]),
            thumbnail: UIImage(),
            capturedAt: date,
            source: .library
        )
        XCTAssertEqual(capture.capturedAt, date)
    }
}
