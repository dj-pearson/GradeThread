import XCTest
@testable import GradeThread

@MainActor
final class AIExtractTests: XCTestCase {

    // MARK: - AIExtractResponse decoding

    /// Captured shape from `services/edge-functions/src/routes/flipdesk-ai.ts`.
    /// Key test: `garment_category` and `garment_type` keys in `suggestions`
    /// must survive verbatim. EdgeAPI's shared decoder applies
    /// convertFromSnakeCase which would mangle them — AIExtractService
    /// specifically bypasses that.
    func test_response_preservesSnakeCaseSuggestionKeys() throws {
        let json = #"""
        {
          "suggestions": {
            "brand": {"value": "Patagonia", "confidence": 0.92, "source": "photo:tag"},
            "size": {"value": "M", "confidence": 0.88, "source": "photo:tag"},
            "garment_category": {"value": "jacket", "confidence": 0.78, "source": "photo:front"},
            "garment_type": {"value": "outerwear", "confidence": 0.81, "source": "photo:front"}
          },
          "condition_summary": "Light wear on cuffs.",
          "conflicts": [],
          "measurements": {"chest": 22.5, "length": 28.0},
          "model": "claude-sonnet-4-5",
          "log_id": "log-abc",
          "actions_remaining": 47
        }
        """#

        let response = try JSONDecoder().decode(AIExtractResponse.self, from: Data(json.utf8))
        XCTAssertNotNil(response.suggestions["garment_category"])
        XCTAssertNotNil(response.suggestions["garment_type"])
        XCTAssertEqual(response.suggestions["brand"]?.value, "Patagonia")
        XCTAssertEqual(response.suggestions["size"]?.confidence, 0.88, accuracy: 0.001)
        XCTAssertEqual(response.conditionSummary, "Light wear on cuffs.")
        XCTAssertEqual(response.measurements?["chest"], 22.5)
        XCTAssertEqual(response.actionsRemaining, 47)
        XCTAssertEqual(response.logId, "log-abc")
    }

    func test_response_decodesEmptyMeasurementsAsNil() throws {
        let json = #"""
        {
          "suggestions": {},
          "condition_summary": null,
          "conflicts": [],
          "measurements": null,
          "model": null,
          "log_id": null,
          "actions_remaining": -1
        }
        """#
        let response = try JSONDecoder().decode(AIExtractResponse.self, from: Data(json.utf8))
        XCTAssertTrue(response.suggestions.isEmpty)
        XCTAssertNil(response.measurements)
        XCTAssertNil(response.conditionSummary)
        XCTAssertNil(response.logId)
        XCTAssertEqual(response.actionsRemaining, -1)
    }

    func test_response_decodesConflicts() throws {
        let json = #"""
        {
          "suggestions": {},
          "condition_summary": null,
          "conflicts": [{"field": "size", "text_value": "M", "photo_value": "L"}],
          "measurements": null,
          "model": null,
          "log_id": null,
          "actions_remaining": 0
        }
        """#
        let response = try JSONDecoder().decode(AIExtractResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.conflicts.count, 1)
        XCTAssertEqual(response.conflicts.first?.field, "size")
        XCTAssertEqual(response.conflicts.first?.textValue, "M")
        XCTAssertEqual(response.conflicts.first?.photoValue, "L")
    }

    // MARK: - Request encoding

    func test_request_encodesItemIdAndPhotosAsSnakeCase() throws {
        let request = AIExtractRequest(
            itemId: "item-1",
            photos: [
                ExtractPhoto(url: "https://example.test/a.jpg", type: "front"),
                ExtractPhoto(url: "https://example.test/b.jpg", type: "tag"),
            ],
            knownFields: nil,
            text: nil
        )
        let data = try JSONEncoder().encode(request)
        let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(parsed?["item_id"] as? String, "item-1")
        let photos = parsed?["photos"] as? [[String: Any]]
        XCTAssertEqual(photos?.count, 2)
        XCTAssertEqual(photos?.first?["type"] as? String, "front")
    }

    // MARK: - AIExtractStore

    func test_store_applyResponse_defaultsAcceptsHighConfidence() {
        let store = AIExtractStore()
        let response = AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Nike", confidence: 0.95, source: "photo:tag"),
                "color": .init(value: "blue", confidence: 0.55, source: "photo:front"),
            ],
            conditionSummary: nil,
            conflicts: [],
            measurements: ["chest": 21.0],
            model: nil,
            logId: nil,
            actionsRemaining: 10
        )
        store.applyResponse(response)

        guard case .ready(let result) = store.phase else {
            return XCTFail("expected ready phase")
        }
        XCTAssertEqual(result.entries.count, 2)
        XCTAssertEqual(result.measurements.count, 1)

        // Auto-acceptance: high-confidence (≥0.8) rows checked by default.
        XCTAssertTrue(store.isAccepted("brand"))
        XCTAssertFalse(store.isAccepted("color"))
        // Measurements default-on when present.
        XCTAssertTrue(store.acceptMeasurements)
    }

    func test_store_acceptedCount_combinesFieldsAndMeasurements() {
        let store = AIExtractStore()
        let response = AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Levi's", confidence: 0.9, source: "photo:tag"),
                "size": .init(value: "32", confidence: 0.85, source: "photo:tag"),
            ],
            conditionSummary: nil,
            conflicts: [],
            measurements: ["waist": 16.0, "length": 30.0],
            model: nil, logId: nil, actionsRemaining: 0
        )
        store.applyResponse(response)
        // 2 fields auto-accepted + 2 measurements toggled on.
        XCTAssertEqual(store.acceptedCount, 4)

        store.acceptMeasurements = false
        XCTAssertEqual(store.acceptedCount, 2)

        store.acceptNone()
        XCTAssertEqual(store.acceptedCount, 0)
    }

    func test_store_toggle_flipsAcceptanceState() {
        let store = AIExtractStore()
        let response = AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Carhartt", confidence: 0.6, source: "photo:tag")
            ],
            conditionSummary: nil,
            conflicts: [],
            measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        )
        store.applyResponse(response)
        XCTAssertFalse(store.isAccepted("brand"))

        store.toggle("brand")
        XCTAssertTrue(store.isAccepted("brand"))
        store.toggle("brand")
        XCTAssertFalse(store.isAccepted("brand"))
    }

    func test_store_acceptAll_picksEveryEntry() {
        let store = AIExtractStore()
        let response = AIExtractResponse(
            suggestions: [
                "brand": .init(value: "A", confidence: 0.3, source: "text"),
                "size": .init(value: "B", confidence: 0.4, source: "text"),
                "color": .init(value: "C", confidence: 0.5, source: "text"),
            ],
            conditionSummary: nil,
            conflicts: [],
            measurements: ["length": 27.0],
            model: nil, logId: nil, actionsRemaining: 0
        )
        store.applyResponse(response)
        // Low-confidence rows aren't default-accepted.
        XCTAssertEqual(store.acceptedFields.count, 0)

        store.acceptAll()
        XCTAssertEqual(store.acceptedFields.count, 3)
        XCTAssertTrue(store.acceptMeasurements)
    }

    func test_entry_displayLabel_titleCasesSnake() {
        let entry = FieldSuggestionEntry(
            id: "garment_category",
            field: "garment_category",
            suggestion: FieldSuggestion(value: "jacket", confidence: 1, source: "text")
        )
        XCTAssertEqual(entry.displayLabel, "Garment Category")
    }

    func test_entry_sourceLabel_humanizesPhotoSources() {
        let textEntry = FieldSuggestionEntry(
            id: "size", field: "size",
            suggestion: FieldSuggestion(value: "M", confidence: 1, source: "text")
        )
        XCTAssertEqual(textEntry.sourceLabel, "From description")

        let tagEntry = FieldSuggestionEntry(
            id: "brand", field: "brand",
            suggestion: FieldSuggestion(value: "Levi's", confidence: 1, source: "photo:tag")
        )
        XCTAssertEqual(tagEntry.sourceLabel, "From tag photo")
    }
}
