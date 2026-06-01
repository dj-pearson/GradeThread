import XCTest
@testable import GradeThread

/// Regression coverage for `SyncEngine.RemoteInventoryItem` decoding.
///
/// Production bug this guards against: `inventory_items.measurements` is a
/// free-form jsonb column, and some rows store values as strings ("20.5")
/// instead of numbers. The pull decodes the whole result array in one shot,
/// so a single such row threw and silently blanked the ENTIRE inventory list
/// on device (the web app, using untyped JS, was unaffected). The decoder is
/// now lenient: numbers and numeric strings survive, anything else is dropped,
/// and decoding never throws on measurement shape.
final class InventoryDecodeTests: XCTestCase {

    private func decodeItem(_ json: String) throws -> SyncEngine.RemoteInventoryItem {
        try JSONDecoder().decode(SyncEngine.RemoteInventoryItem.self, from: Data(json.utf8))
    }

    private func itemJSON(measurements: String) -> String {
        #"""
        {"id":"a","user_id":"u","title":"t","status":"listed",
         "measurements":\#(measurements),
         "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}
        """#
    }

    func test_stringValuedMeasurements_decodeAsNumbers() throws {
        let item = try decodeItem(itemJSON(measurements: #"{"width":"20.5","length":"27"}"#))
        XCTAssertEqual(item.measurements?["width"], 20.5)
        XCTAssertEqual(item.measurements?["length"], 27)
    }

    func test_mixedNumberAndStringMeasurements() throws {
        let item = try decodeItem(itemJSON(measurements: #"{"chest":22,"width":"23","length":"30.5"}"#))
        XCTAssertEqual(item.measurements?["chest"], 22)
        XCTAssertEqual(item.measurements?["width"], 23)
        XCTAssertEqual(item.measurements?["length"], 30.5)
    }

    func test_nonNumericValuesAreDropped_notThrown() throws {
        let item = try decodeItem(itemJSON(
            measurements: #"{"chest":{"value":22,"unit":"in"},"note":"n/a","width":"19"}"#))
        XCTAssertEqual(item.measurements?["width"], 19)
        XCTAssertNil(item.measurements?["chest"])
        XCTAssertNil(item.measurements?["note"])
    }

    func test_arrayShapedMeasurements_doNotThrow() throws {
        let item = try decodeItem(itemJSON(measurements: "[]"))
        XCTAssertTrue(item.measurements?.isEmpty ?? true)
    }

    func test_nullMeasurements_isNil() throws {
        let item = try decodeItem(itemJSON(measurements: "null"))
        XCTAssertNil(item.measurements)
    }

    func test_wellFormedNumericMeasurements_unchanged() throws {
        let item = try decodeItem(itemJSON(measurements: #"{"chest":22.5,"length":28.0}"#))
        XCTAssertEqual(item.measurements?["chest"], 22.5)
        XCTAssertEqual(item.measurements?["length"], 28.0)
    }

    /// The exact regression: a batch where one row has string-valued
    /// measurements must still decode every row, not blow up the whole array.
    func test_batchWithOneStringMeasurementRow_decodesAllRows() throws {
        let json = #"""
        [
          {"id":"a","user_id":"u","title":"good","status":"listed",
           "measurements":{"width":20.0},
           "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"},
          {"id":"b","user_id":"u","title":"string measurements","status":"listed",
           "measurements":{"width":"20.5","length":"27"},
           "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}
        ]
        """#
        let items = try JSONDecoder().decode(
            [SyncEngine.RemoteInventoryItem].self, from: Data(json.utf8))
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].measurements?["width"], 20.0)
        XCTAssertEqual(items[1].measurements?["length"], 27)
    }

    /// Belt-and-suspenders: even a row that fails to decode entirely (here the
    /// second is missing the required `title`) must not blank the whole list —
    /// the resilient pull drops only the bad row and keeps the good ones.
    func test_resilientDecode_dropsBadRow_keepsGoodRows() {
        let json = #"""
        [
          {"id":"a","user_id":"u","title":"good","status":"listed",
           "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"},
          {"id":"b","user_id":"u","status":"listed",
           "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}
        ]
        """#
        let items = SyncEngine.decodeItemsResiliently(Data(json.utf8))
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?.title, "good")
    }
}
