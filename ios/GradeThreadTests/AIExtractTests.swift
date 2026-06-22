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
        XCTAssertEqual(try XCTUnwrap(response.suggestions["size"]?.confidence), 0.88, accuracy: 0.001)
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

    // MARK: - Auto-fill review (US-686)

    /// High-confidence (>=0.8) fields go into `applied`; the rest are surfaced as
    /// `lowConfidence` for opt-in. Pre-fill snapshot values become each applied
    /// field's `previousValue` for undo.
    func test_buildFillReview_partitionsByConfidenceAndCapturesPrevious() throws {
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Nike", confidence: 0.95, source: "photo:tag"),
                "size": .init(value: "M", confidence: 0.82, source: "photo:tag"),
                "color": .init(value: "blue", confidence: 0.55, source: "photo:front"),
            ],
            conditionSummary: "Light wear.",
            conflicts: [],
            measurements: ["chest": 21.0],
            model: nil, logId: nil, actionsRemaining: 10
        ))

        var snapshot = AIItemFieldWriter.Snapshot()
        snapshot.brand = "Old Brand"   // had a prior value; size/color were empty

        let review = try XCTUnwrap(store.buildFillReview(itemId: "item-1", snapshot: snapshot))

        XCTAssertEqual(review.itemId, "item-1")
        XCTAssertEqual(Set(review.applied.map(\.field)), ["brand", "size"])
        XCTAssertEqual(review.lowConfidence.map(\.field), ["color"])
        XCTAssertEqual(review.conditionSummary, "Light wear.")
        XCTAssertTrue(review.measurementsApplied)

        let brand = review.applied.first { $0.field == "brand" }
        XCTAssertEqual(brand?.previousValue, "Old Brand")
        let size = review.applied.first { $0.field == "size" }
        XCTAssertNil(size?.previousValue)
        // applied fields (2) + applied measurements (1)
        XCTAssertEqual(review.appliedCount, 3)
    }

    func test_buildFillReview_returnsNilWhenNotReady() {
        let store = AIExtractStore()  // still in .waitingForUploads
        XCTAssertNil(store.buildFillReview(itemId: "x", snapshot: AIItemFieldWriter.Snapshot()))
    }

    func test_fillReview_entryPointLabel_reflectsAppliedThenSuggestions() {
        let applied = AIFillReview(
            itemId: "a",
            applied: [AppliedAIField(field: "brand", value: "Nike", previousValue: nil, confidence: 0.9, source: "photo:tag")],
            lowConfidence: [],
            measurements: [],
            measurementsApplied: false,
            conditionSummary: nil,
            usedLiveTextFallback: false
        )
        XCTAssertEqual(applied.entryPointLabel, "AI filled 1 field — review")

        let suggestionsOnly = AIFillReview(
            itemId: "b",
            applied: [],
            lowConfidence: [
                FieldSuggestionEntry(id: "color", field: "color", suggestion: .init(value: "blue", confidence: 0.4, source: "live-text")),
                FieldSuggestionEntry(id: "size", field: "size", suggestion: .init(value: "M", confidence: 0.4, source: "live-text")),
            ],
            measurements: [],
            measurementsApplied: false,
            conditionSummary: nil,
            usedLiveTextFallback: true
        )
        XCTAssertEqual(suggestionsOnly.entryPointLabel, "AI has 2 suggestions — review")
        XCTAssertTrue(suggestionsOnly.hasSomethingToReview)
    }

    func test_fillReviewStore_registerAndClear() {
        let store = AIFillReviewStore.shared
        store.clear(for: "item-42")
        XCTAssertNil(store.review(for: "item-42"))

        let review = AIFillReview(
            itemId: "item-42",
            applied: [AppliedAIField(field: "brand", value: "Levi's", previousValue: nil, confidence: 0.9, source: "photo:tag")],
            lowConfidence: [],
            measurements: [],
            measurementsApplied: false,
            conditionSummary: nil,
            usedLiveTextFallback: false
        )
        store.register(review)
        XCTAssertEqual(store.review(for: "item-42")?.applied.count, 1)

        store.clear(for: "item-42")
        XCTAssertNil(store.review(for: "item-42"))
    }

    // MARK: - Title seed (US-682: never land on a bare "Untitled item")

    /// An explicit `title` suggestion wins, even at low confidence — so a
    /// no-tag / moderate-confidence capture still names the item.
    func test_bestTitleSeed_prefersTitleSuggestion() {
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: [
                "title": .init(value: "Vintage Wool Coat", confidence: 0.41, source: "photo:front"),
                "brand": .init(value: "Pendleton", confidence: 0.5, source: "photo:front"),
            ],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        XCTAssertEqual(store.bestTitleSeed(), "Vintage Wool Coat")
    }

    /// With no title field, compose brand + style (preferred) or brand + size —
    /// regardless of confidence — so the seed is non-nil whenever there's any
    /// nameable signal.
    func test_bestTitleSeed_composesBrandAndStyleOrSize() {
        let withStyle = AIExtractStore()
        withStyle.applyResponse(AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Levi's", confidence: 0.3, source: "photo:front"),
                "style": .init(value: "501", confidence: 0.3, source: "photo:front"),
                "size": .init(value: "32", confidence: 0.3, source: "photo:front"),
            ],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        // style is preferred over size for the second token.
        XCTAssertEqual(withStyle.bestTitleSeed(), "Levi's 501")

        let withSizeOnly = AIExtractStore()
        withSizeOnly.applyResponse(AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Nike", confidence: 0.2, source: "photo:front"),
                "size": .init(value: "L", confidence: 0.2, source: "photo:front"),
            ],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        XCTAssertEqual(withSizeOnly.bestTitleSeed(), "Nike L")
    }

    func test_bestTitleSeed_nilWhenNothingNameable() {
        let empty = AIExtractStore()
        empty.applyResponse(AIExtractResponse(
            suggestions: [
                "color": .init(value: "blue", confidence: 0.9, source: "photo:front"),
            ],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        XCTAssertNil(empty.bestTitleSeed())

        let notReady = AIExtractStore()  // still waiting for uploads
        XCTAssertNil(notReady.bestTitleSeed())
    }

    /// The explicit title seed names the row even when NO field cleared the
    /// auto-apply bar (so brand/style/size columns are all nil) — the
    /// silent-"Untitled" case.
    func test_seededTitle_explicitNamesRowWhenNoColumnsApplied() {
        XCTAssertEqual(
            AIItemFieldWriter.seededTitle(brand: nil, style: nil, size: nil, explicit: "Carhartt Jacket"),
            "Carhartt Jacket"
        )
    }

    /// An explicit seed wins over the composed brand/size fallback; with no
    /// explicit seed, compose from the applied columns; nil when nothing.
    func test_seededTitle_explicitWinsThenComposesThenNil() {
        XCTAssertEqual(
            AIItemFieldWriter.seededTitle(brand: "Nike", style: nil, size: "M", explicit: "Nike Dri-FIT Tee"),
            "Nike Dri-FIT Tee"
        )
        XCTAssertEqual(
            AIItemFieldWriter.seededTitle(brand: "Nike", style: nil, size: "M", explicit: nil),
            "Nike M"
        )
        XCTAssertEqual(
            AIItemFieldWriter.seededTitle(brand: "Levi's", style: "501", size: "32", explicit: "   "),
            "Levi's 501"
        )
        XCTAssertNil(
            AIItemFieldWriter.seededTitle(brand: nil, style: nil, size: nil, explicit: nil)
        )
    }

    // MARK: - Auto-present queue (US-686 follow-up)

    func test_fillReviewStore_autoPresentQueue_isOnceOnly() {
        let store = AIFillReviewStore.shared
        store.clear(for: "item-ap")

        let review = AIFillReview(
            itemId: "item-ap",
            applied: [],
            lowConfidence: [
                FieldSuggestionEntry(id: "brand", field: "brand", suggestion: .init(value: "Nike", confidence: 0.4, source: "photo:front")),
            ],
            measurements: [], measurementsApplied: false,
            conditionSummary: nil, usedLiveTextFallback: false
        )

        // Registered WITHOUT auto-present: banner only, no popup.
        store.register(review)
        XCTAssertFalse(store.shouldAutoPresent("item-ap"))

        // Registered WITH auto-present (post-intake): pops once, then not again.
        store.register(review, autoPresent: true)
        XCTAssertTrue(store.shouldAutoPresent("item-ap"))
        store.markAutoPresented("item-ap")
        XCTAssertFalse(store.shouldAutoPresent("item-ap"))

        // Clearing also drops any pending auto-present.
        store.register(review, autoPresent: true)
        store.clear(for: "item-ap")
        XCTAssertFalse(store.shouldAutoPresent("item-ap"))
    }

    /// Undo writes must null restored-empty columns explicitly (the sparse fill
    /// encoder would otherwise skip them), and clear the AI bookkeeping.
    func test_revertUpdate_encodesExplicitNullsAndRestoredValues() throws {
        let update = AIItemFieldWriter.RevertUpdate(
            columns: ["brand": nil, "size": "M"],
            clearMeasurements: true,
            clearAISources: true
        )
        let data = try JSONEncoder().encode(update)
        let parsed = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any]
        let json = try XCTUnwrap(parsed)

        XCTAssertTrue(json.keys.contains("brand"))
        XCTAssertTrue(json["brand"] is NSNull)
        XCTAssertEqual(json["size"] as? String, "M")
        XCTAssertTrue(json["measurements"] is NSNull)
        XCTAssertTrue(json["ai_field_sources"] is NSNull)
        XCTAssertTrue(json["ai_enriched_at"] is NSNull)
    }
}
