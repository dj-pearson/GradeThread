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
                "color": .init(value: "blue", confidence: 0.45, source: "photo:front"),
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

        // Auto-acceptance: medium-and-up (≥0.5) rows checked by default; the
        // 0.45 color stays below the bar.
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
                "brand": .init(value: "Carhartt", confidence: 0.4, source: "photo:tag")
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
                "color": .init(value: "C", confidence: 0.45, source: "text"),
            ],
            conditionSummary: nil,
            conflicts: [],
            measurements: ["length": 27.0],
            model: nil, logId: nil, actionsRemaining: 0
        )
        store.applyResponse(response)
        // All rows below the 0.5 bar — none default-accepted.
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
                "color": .init(value: "blue", confidence: 0.45, source: "photo:front"),
            ],
            conditionSummary: "Light wear.",
            conflicts: [],
            measurements: ["chest": 21.0],
            model: nil, logId: nil, actionsRemaining: 10
        ))

        // US-2267: the placeholder title is treated as unset, so it auto-applies
        // and carries its prior value for undo. brand/size/color start empty.
        var snapshot = AIItemFieldWriter.Snapshot()
        snapshot.title = AIItemFieldWriter.placeholderTitle

        let review = try XCTUnwrap(store.buildFillReview(itemId: "item-1", snapshot: snapshot))

        XCTAssertEqual(review.itemId, "item-1")
        // brand 0.95 + size 0.82 clear the 0.8 write bar; color 0.45 stays opt-in.
        XCTAssertEqual(Set(review.applied.map(\.field)), ["brand", "size"])
        XCTAssertEqual(review.lowConfidence.map(\.field), ["color"])
        XCTAssertEqual(review.conditionSummary, "Light wear.")
        XCTAssertTrue(review.measurementsApplied)

        // Applied fields were previously UNSET (that is now a precondition of
        // auto-applying at all), so there is nothing to restore on undo.
        let brand = review.applied.first { $0.field == "brand" }
        XCTAssertNil(brand?.previousValue)
        let size = review.applied.first { $0.field == "size" }
        XCTAssertNil(size?.previousValue)
        // applied fields (2) + applied measurements (1)
        XCTAssertEqual(review.appliedCount, 3)
    }

    /// The placeholder title is the one applied field that DOES carry a prior
    /// value, so undoing it restores the placeholder rather than nulling a NOT NULL
    /// column.
    func test_buildFillReview_appliedTitleCarriesPlaceholderForUndo() throws {
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: ["title": .init(value: "Patagonia Nano Puff", confidence: 0.9, source: "photo:front")],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        var snapshot = AIItemFieldWriter.Snapshot()
        snapshot.title = AIItemFieldWriter.placeholderTitle
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: snapshot))
        let title = try XCTUnwrap(review.applied.first { $0.field == "title" })
        XCTAssertEqual(title.previousValue, AIItemFieldWriter.placeholderTitle)
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

    // MARK: - Write-bar boundary + resolved eBay category (US-822, US-2267)

    /// The write bar is exclusive at 0.8: 0.8 writes, 0.79 doesn't.
    ///
    /// This replaces the old 0.5-bar assertion. That bar was set low so a
    /// moderate-confidence capture would fill the listing rather than land on a
    /// near-empty item — but the cost was writing guesses the seller hadn't seen,
    /// which is not what the web does. The near-empty worry is now covered by the
    /// title seed (US-682), the auto-presenting review, the pre-ticked opt-in rows,
    /// and the re-run (US-2266).
    func test_buildFillReview_writeBarIsExclusiveAt08() throws {
        XCTAssertEqual(AIExtractStore.autoApplyConfidenceThreshold, 0.8, accuracy: 0.0001)
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Patagonia", confidence: 0.80, source: "photo:front"),
                "size":  .init(value: "M",         confidence: 0.79, source: "photo:front"),
            ],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot()))
        XCTAssertEqual(review.applied.map(\.field), ["brand"])
        XCTAssertEqual(review.lowConfidence.map(\.field), ["size"])
    }

    func test_ebaySummary_nilWhenNoBlockOrEmptyId() {
        XCTAssertNil(AIFillReview.EbaySummary(from: nil))
        XCTAssertNil(AIFillReview.EbaySummary(
            from: AIExtractEbayBlock(categoryId: "", categoryPath: "Men > Shirts", aspects: [:])
        ))
    }

    func test_ebaySummary_displayNameLeafAndAspectCount() throws {
        let block = AIExtractEbayBlock(
            categoryId: "57988",
            categoryPath: "Clothing, Shoes & Accessories > Men > Shirts",
            aspects: ["Brand": ["Nike"], "Size": ["M"], "Color": []]  // empty value isn't counted
        )
        let summary = try XCTUnwrap(AIFillReview.EbaySummary(from: block))
        XCTAssertEqual(summary.displayName, "Shirts")
        XCTAssertEqual(summary.filledAspectCount, 2)
        XCTAssertEqual(summary.categoryId, "57988")
    }

    func test_ebaySummary_displayNameFallsBackToIdWhenNoPath() throws {
        let summary = try XCTUnwrap(AIFillReview.EbaySummary(
            from: AIExtractEbayBlock(categoryId: "11450", categoryPath: nil, aspects: [:])
        ))
        XCTAssertEqual(summary.displayName, "eBay category 11450")
        XCTAssertEqual(summary.filledAspectCount, 0)
    }

    /// The resolved/persisted eBay category rides along in the review so it's
    /// visible right after intake, and on its own makes the review worth showing.
    func test_buildFillReview_includesResolvedEbayCategory() throws {
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: ["brand": .init(value: "Nike", confidence: 0.9, source: "photo:tag")],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0,
            ebay: AIExtractEbayBlock(categoryId: "57988", categoryPath: "Men > Shirts", aspects: ["Brand": ["Nike"]])
        ))
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i1", snapshot: AIItemFieldWriter.Snapshot()))
        XCTAssertEqual(review.ebayCategory?.categoryId, "57988")
        XCTAssertEqual(review.ebayCategory?.displayName, "Shirts")
        XCTAssertTrue(review.hasSomethingToReview)
    }

    // MARK: - Conflict threading (US-1217)

    /// A text-vs-photo conflict on a high-error field (size/brand) must NOT be
    /// silently resolved: the tag (text) candidate is forced into the opt-in
    /// review at lowered confidence so the user explicitly chooses. Previously
    /// `response.conflicts` was dropped and whichever value landed in
    /// `suggestions` won silently.
    func test_applyResponse_threadsConflictAsLowConfidenceReviewRow() throws {
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: [
                // The photo vision resolved size to "L" with high confidence —
                // without conflict handling this would auto-apply silently.
                "size": .init(value: "L", confidence: 0.92, source: "photo:front"),
            ],
            conditionSummary: nil,
            // …but the tag OCR read "M". Disagreement on a high-error field.
            conflicts: [FieldConflict(field: "size", textValue: "M", photoValue: "L")],
            measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))

        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot()))
        // The size row was re-keyed to the tag value, dropped below the bar, and
        // surfaced for opt-in — NOT auto-applied to the photo value.
        XCTAssertTrue(review.applied.isEmpty, "conflicted field must not auto-apply")
        let size = try XCTUnwrap(review.lowConfidence.first { $0.field == "size" })
        XCTAssertEqual(size.value, "M", "tag (text) candidate is preferred")
        XCTAssertEqual(size.confidence, AIExtractStore.conflictReviewConfidence, accuracy: 0.0001)
        XCTAssertEqual(size.source, "conflict:tag")
        XCTAssertEqual(size.sourceLabel, "Tag value — conflicts with photo")
    }

    /// When the conflicted field has no `suggestions` entry at all, a fresh
    /// opt-in row is injected for the tag candidate so the disagreement is never
    /// lost. A conflict on a non-high-error field (e.g. color) is left alone.
    func test_applyResponse_injectsMissingConflictRow_andIgnoresLowRiskFields() throws {
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: [:],
            conditionSummary: nil,
            conflicts: [
                FieldConflict(field: "brand", textValue: "Patagonia", photoValue: "Prana"),
                FieldConflict(field: "color", textValue: "Navy", photoValue: "Black"),
            ],
            measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot()))
        let brand = try XCTUnwrap(review.lowConfidence.first { $0.field == "brand" })
        XCTAssertEqual(brand.value, "Patagonia")
        XCTAssertEqual(brand.source, "conflict:tag")
        // color isn't a gated high-error field, so no row is injected for it.
        XCTAssertFalse(review.lowConfidence.contains { $0.field == "color" })
        XCTAssertFalse(review.applied.contains { $0.field == "color" })
    }

    /// A department conflict is gated (it's a high-error, almost-always-required
    /// eBay aspect) and routed to the opt-in review like size/brand.
    func test_applyResponse_threadsDepartmentConflict() throws {
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: [:],
            conditionSummary: nil,
            conflicts: [FieldConflict(field: "department", textValue: "Women", photoValue: "Men")],
            measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot()))
        let dept = try XCTUnwrap(review.lowConfidence.first { $0.field == "department" })
        XCTAssertEqual(dept.value, "Women")
        XCTAssertTrue(AIAttributeConfirm.keys.contains("department"))
    }

    // MARK: - Background extraction manager (US-686 follow-up)

    func test_extractionManager_unknownItem_isIdleAndClearIsSafe() {
        let mgr = AIExtractionManager.shared
        let id = "no-such-item-\(UUID().uuidString)"
        XCTAssertNil(mgr.phase(for: id))
        XCTAssertFalse(mgr.isRunning(id))
        mgr.clear(for: id)            // must be a safe no-op for an unknown id
        XCTAssertNil(mgr.phase(for: id))
        XCTAssertFalse(mgr.isRunning(id))
    }

    // MARK: - The AI description must actually land (US-2277)

    /// The reported symptom: after an iOS add, the description is blank. The server
    /// composes one, iOS can write it, and the sync pulls it back — the only thing
    /// stopping it was the confidence bar, which a composed paragraph rates itself
    /// below far more often than a tag read does.
    func test_description_isAppliedBelowTheConfidenceBar() throws {
        let store = readyStore([
            "description": .init(
                value: "Patagonia Nano Puff in navy. Men's medium, ripstop shell, full zip. Light wear, no holes or stains.",
                confidence: 0.6,
                source: "photo:front"
            ),
            // An OBSERVED field at the same confidence stays an opt-in row — the
            // exemption is for composed prose only, not a blanket lowering.
            "brand": .init(value: "Patagonia", confidence: 0.6, source: "photo:tag"),
        ])
        let review = try XCTUnwrap(
            store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot())
        )
        XCTAssertEqual(review.applied.map(\.field), ["description"])
        XCTAssertEqual(review.lowConfidence.map(\.field), ["brand"])
    }

    /// The never-overwrite rule still wins: a description the seller wrote is not
    /// replaced, however the AI rates its own.
    func test_description_doesNotOverwriteTheSellersOwnCopy() throws {
        let store = readyStore([
            "description": .init(value: "AI copy", confidence: 0.99, source: "photo:front"),
        ])
        var snapshot = AIItemFieldWriter.Snapshot()
        snapshot.description = "The seller's own description"
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: snapshot))
        XCTAssertTrue(review.applied.isEmpty)
        XCTAssertEqual(review.lowConfidence.map(\.field), ["description"])
    }

    func test_composedProseSet_isNarrow() {
        // Deliberately just the one field. condition_notes is an OBSERVATION
        // ("condition hints explicitly mentioned or visible"), so it stays barred.
        XCTAssertEqual(AIExtractStore.composedProseFields, ["description"])
    }

    // MARK: - Stale SwiftData row on the item canvas (US-2276)

    /// The rule the canvas now applies before drawing anything. Pulled out as a
    /// pure function of (live rows, held object) so it is testable without a model
    /// container or a view: reference identity is the whole trick, because a
    /// delete-and-reinsert produces a live row with the SAME id and a DIFFERENT
    /// instance — which is what rendered as a blank screen.
    private func staleReason(
        liveRows: [AnyObject],
        held: AnyObject
    ) -> String? {
        guard let live = liveRows.first else { return "removed" }
        return live === held ? nil : "replaced"
    }

    func test_staleRowRule_distinguishesRemovedReplacedAndHealthy() {
        final class Row {}
        let held = Row()

        // Healthy: the live row IS the object the screen holds.
        XCTAssertNil(staleReason(liveRows: [held], held: held))

        // Pruned: the merge deleted it and nothing replaced it.
        XCTAssertEqual(staleReason(liveRows: [], held: held), "removed")

        // Delete-and-reinsert: a live row exists for the id, but it's a different
        // instance. Same id, so an id comparison would call this healthy — and the
        // screen would keep drawing the dead object with every field empty.
        XCTAssertEqual(staleReason(liveRows: [Row()], held: held), "replaced")
    }

    // MARK: - Background eBay category pass (US-2270)

    /// The current edge build always returns `ebay: null` + `ebay_pending: true`,
    /// because the category/aspects pass moved to a background task. A client that
    /// only reads `ebay` concludes the phase failed.
    func test_response_decodesEbayPending() throws {
        let json = #"""
        {
          "suggestions": {"brand": {"value": "Nike", "confidence": 0.9, "source": "photo:tag"}},
          "condition_summary": null,
          "conflicts": [],
          "measurements": null,
          "model": "claude",
          "log_id": "l1",
          "actions_remaining": 4,
          "ebay": null,
          "ebay_pending": true
        }
        """#
        let response = try JSONDecoder().decode(AIExtractResponse.self, from: Data(json.utf8))
        XCTAssertNil(response.ebay)
        XCTAssertTrue(response.ebayPending)

        // An older edge build omits the key — that is NOT pending.
        let older = #"""
        {"suggestions": {}, "conflicts": [], "actions_remaining": 0}
        """#
        let legacy = try JSONDecoder().decode(AIExtractResponse.self, from: Data(older.utf8))
        XCTAssertFalse(legacy.ebayPending)
        XCTAssertNil(legacy.ebay)
    }

    /// The review must distinguish "still resolving" from "skipped/failed" — they
    /// looked identical before, and the review said nothing at all.
    func test_buildFillReview_marksEbayCategoryPending() throws {
        var response = AIExtractResponse(
            suggestions: ["brand": .init(value: "Nike", confidence: 0.9, source: "photo:tag")],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        )
        response.ebayPending = true

        let store = AIExtractStore()
        store.applyResponse(response)
        XCTAssertTrue(store.ebayPendingCategory)

        let review = try XCTUnwrap(
            store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot())
        )
        XCTAssertNil(review.ebayCategory, "nothing inline to show yet")
        XCTAssertEqual(review.ebayCategoryPending, true)
    }

    /// A resolved INLINE block wins: there is nothing pending to announce.
    func test_buildFillReview_inlineEbayBlockIsNotPending() throws {
        var response = AIExtractResponse(
            suggestions: [:],
            conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        )
        response.ebay = AIExtractEbayBlock(
            categoryId: "57990",
            categoryPath: "Clothing > Men > Shirts",
            aspects: ["Brand": ["Nike"], "Size": []]
        )
        response.ebayPending = true

        let store = AIExtractStore()
        store.applyResponse(response)
        let review = try XCTUnwrap(
            store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot())
        )
        XCTAssertEqual(review.ebayCategory?.categoryId, "57990")
        XCTAssertEqual(review.ebayCategory?.filledAspectCount, 1, "an empty array isn't a specific")
        XCTAssertEqual(review.ebayCategoryPending, false)
    }

    /// A review persisted BEFORE this field existed must still decode (US-1171
    /// keeps them on disk). This is the trap that broke AIExtractResponse.attributes:
    /// a non-Optional stored property still requires its key.
    func test_review_decodesWithoutTheNewPendingKey() throws {
        let json = #"""
        {
          "itemId": "i1",
          "applied": [],
          "lowConfidence": [],
          "measurements": [],
          "measurementsApplied": false,
          "usedLiveTextFallback": false
        }
        """#
        let review = try JSONDecoder().decode(AIFillReview.self, from: Data(json.utf8))
        XCTAssertEqual(review.itemId, "i1")
        XCTAssertNil(review.ebayCategoryPending)
        XCTAssertNil(review.ebayCategory)
    }

    /// The category is persisted server-side ~20s after the extract returns, so the
    /// pull fired at completion is too early. A follow-up pull is what makes it
    /// appear without the seller opening the specifics editor.
    func test_pendingEbayPass_schedulesAFollowUpPull() async {
        let original = AIExtractionManager.ebayFollowUpPullDelaySeconds
        AIExtractionManager.ebayFollowUpPullDelaySeconds = 0.05
        defer { AIExtractionManager.ebayFollowUpPullDelaySeconds = original }

        let expectation = expectation(forNotification: .inventoryPullRequested, object: nil)

        let mgr = AIExtractionManager.shared
        let id = "ebay-followup-\(UUID().uuidString)"
        mgr.clear(for: id)
        // isOffline short-circuits before the network; the offline branch does NOT
        // schedule a follow-up, so drive the scheduler through the store state the
        // real path uses.
        var response = AIExtractResponse(
            suggestions: [:], conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        )
        response.ebayPending = true
        let store = AIExtractStore()
        store.applyResponse(response)
        XCTAssertTrue(store.ebayPendingCategory)

        mgr.scheduleEbayFollowUpPull()
        await fulfillment(of: [expectation], timeout: 2)
    }

    /// And it must NOT fire when there is no background pass to wait for.
    func test_noPendingEbayPass_meansNoPendingFlag() {
        let response = AIExtractResponse(
            suggestions: [:], conditionSummary: nil, conflicts: [], measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        )
        let store = AIExtractStore()
        store.applyResponse(response)
        XCTAssertFalse(store.ebayPendingCategory)
        let review = store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot())
        XCTAssertEqual(review?.ebayCategoryPending, false)
    }

    // MARK: - known_fields + text on both entry points (US-2268)

    /// The server deletes every `known_fields` key from its suggestions, so sending
    /// what the seller already filled is what stops the AI competing with it.
    func test_inputs_knownFieldsCoverTheStructuredColumns() throws {
        let inputs = AIExtractInputs(
            title: "Nike windbreaker",
            brand: "Nike",
            size: "L",
            itemCategory: "clothing"
        )
        let known = try XCTUnwrap(inputs.knownFields)
        XCTAssertEqual(Set(known.keys), ["brand", "size", "item_category"])

        // Encoded shape: flat strings under the server's column names.
        let request = AIExtractRequest(
            itemId: "i", photos: [], knownFields: known, text: inputs.text
        )
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )
        let sent = try XCTUnwrap(json["known_fields"] as? [String: Any])
        XCTAssertEqual(sent["brand"] as? String, "Nike")
        XCTAssertEqual(sent["size"] as? String, "L")
        // Free text never doubles as a known field — the AI is meant to read it.
        XCTAssertNil(sent["title"])
        XCTAssertNil(sent["description"])
        XCTAssertNil(sent["condition_notes"])
    }

    /// Mirrors the server contract in flipdesk-ai.ts: a known key is stripped from
    /// `suggestions` before the response is built, so a known field can never come
    /// back and reach the auto-apply path.
    func test_knownField_cannotComeBackAsAnAppliedSuggestion() throws {
        // What the server returns for known brand+size: those keys are gone.
        let store = readyStore([
            "color": .init(value: "Navy", confidence: 0.9, source: "photo:front"),
        ])
        var snapshot = AIItemFieldWriter.Snapshot()
        snapshot.brand = "Nike"
        snapshot.size = "L"
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: snapshot))

        XCTAssertEqual(review.applied.map(\.field), ["color"])
        XCTAssertFalse(review.applied.contains { $0.field == "brand" || $0.field == "size" })
        XCTAssertFalse(review.lowConfidence.contains { $0.field == "brand" || $0.field == "size" })
    }

    /// Text is the WINNING source for condition notes server-side, so the seller's
    /// own words have to reach it. The placeholder title must not: it isn't
    /// something they wrote, and the model would try to reconcile it.
    func test_inputs_textJoinsSellerCopyAndDropsThePlaceholderTitle() {
        let written = AIExtractInputs(
            title: "Patagonia Nano Puff",
            itemDescription: "Light wear, no holes.",
            conditionNotes: "Small mark on the left cuff"
        )
        XCTAssertEqual(
            written.text,
            "Patagonia Nano Puff\nLight wear, no holes.\nSmall mark on the left cuff"
        )

        // A brand-new photo-first row: title is the placeholder, nothing else set.
        let fresh = AIExtractInputs(title: AIItemFieldWriter.placeholderTitle)
        XCTAssertNil(fresh.text, "the placeholder is not seller copy")
        XCTAssertNil(fresh.knownFields)
        XCTAssertTrue(fresh.isEmpty)

        // Blank and whitespace-only values contribute nothing.
        let blank = AIExtractInputs(title: "  ", itemDescription: "", brand: "   ")
        XCTAssertNil(blank.text)
        XCTAssertNil(blank.knownFields)
    }

    /// A bare capture still sends photos and omits both keys entirely, preserving
    /// today's photo-only behaviour rather than sending empty objects.
    func test_bareCapture_omitsKnownFieldsAndText() throws {
        let inputs = AIExtractInputs(snapshot: {
            var s = AIItemFieldWriter.Snapshot()
            s.title = AIItemFieldWriter.placeholderTitle
            return s
        }())
        XCTAssertNil(inputs.knownFields)
        XCTAssertNil(inputs.text)

        let request = AIExtractRequest(
            itemId: "i",
            photos: [ExtractPhoto(url: "https://pub/front.jpg", type: "front")],
            knownFields: inputs.knownFields,
            text: inputs.text
        )
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )
        XCTAssertNil(json["known_fields"])
        XCTAssertNil(json["text"])
        XCTAssertEqual((json["photos"] as? [[String: Any]])?.count, 1)
    }

    /// The snapshot initialiser is what the post-capture path uses, so it has to map
    /// every column the shaper reads.
    func test_inputs_fromSnapshot_mapsEveryColumn() throws {
        var s = AIItemFieldWriter.Snapshot()
        s.title = "T"; s.description = "D"; s.conditionNotes = "C"
        s.brand = "B"; s.style = "S"; s.size = "M"; s.color = "Blue"
        s.material = "Cotton"; s.itemCategory = "clothing"
        s.garmentType = "tops"; s.garmentCategory = "t-shirt"

        let inputs = AIExtractInputs(snapshot: s)
        XCTAssertEqual(inputs.text, "T\nD\nC")
        let known = try XCTUnwrap(inputs.knownFields)
        XCTAssertEqual(
            Set(known.keys),
            ["brand", "style", "size", "color", "material",
             "item_category", "garment_type", "garment_category"]
        )
    }

    // MARK: - Write bar vs pre-tick bar (US-2267)

    private func readyStore(
        _ suggestions: [String: FieldSuggestion],
        conflicts: [FieldConflict] = []
    ) -> AIExtractStore {
        let store = AIExtractStore()
        store.applyResponse(AIExtractResponse(
            suggestions: suggestions,
            conditionSummary: nil,
            conflicts: conflicts,
            measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        ))
        return store
    }

    /// The behaviour difference from web: a MEDIUM-confidence guess used to be
    /// written to the item before the seller had seen it. It must now be an opt-in
    /// row instead.
    func test_mediumConfidence_isOptInNotWritten() throws {
        let store = readyStore([
            "brand": .init(value: "Patagonia", confidence: 0.5, source: "photo:tag"),
            "color": .init(value: "Blue", confidence: 0.79, source: "photo:front"),
            "size": .init(value: "M", confidence: 0.8, source: "photo:tag"),
        ])
        let review = try XCTUnwrap(
            store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot())
        )
        // Only the field at/above the write bar is applied unasked.
        XCTAssertEqual(review.applied.map(\.field), ["size"])
        XCTAssertEqual(Set(review.lowConfidence.map(\.field)), ["brand", "color"])
    }

    /// The web's core promise, which iOS didn't keep: a confident read must not
    /// overwrite something the seller already filled in.
    func test_confidentValue_doesNotOverwriteAFilledField() throws {
        let store = readyStore([
            "brand": .init(value: "Nike", confidence: 0.97, source: "photo:tag"),
            "size": .init(value: "L", confidence: 0.95, source: "photo:tag"),
        ])
        var snapshot = AIItemFieldWriter.Snapshot()
        snapshot.brand = "Patagonia"      // the seller typed this
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: snapshot))

        XCTAssertEqual(review.applied.map(\.field), ["size"], "only the empty field is written")
        let brand = try XCTUnwrap(review.lowConfidence.first { $0.field == "brand" })
        XCTAssertEqual(brand.value, "Nike", "the suggestion is still offered, just not applied")
    }

    /// A brand-new photo-first row's title is the placeholder, not empty — so the
    /// never-overwrite rule has to treat it as unset or the item stays "Untitled
    /// item", the exact dead end US-682 exists to prevent.
    func test_placeholderTitle_countsAsUnset() throws {
        XCTAssertTrue(AIItemFieldWriter.isUnset(AIItemFieldWriter.placeholderTitle, field: "title"))
        XCTAssertTrue(AIItemFieldWriter.isUnset("  ", field: "brand"))
        XCTAssertFalse(AIItemFieldWriter.isUnset("Real Title", field: "title"))
        // The placeholder is only special for `title`.
        XCTAssertFalse(AIItemFieldWriter.isUnset(AIItemFieldWriter.placeholderTitle, field: "brand"))

        let store = readyStore([
            "title": .init(value: "Patagonia Nano Puff", confidence: 0.9, source: "photo:front"),
        ])
        var snapshot = AIItemFieldWriter.Snapshot()
        snapshot.title = AIItemFieldWriter.placeholderTitle
        let review = try XCTUnwrap(store.buildFillReview(itemId: "i", snapshot: snapshot))
        XCTAssertEqual(review.applied.map(\.field), ["title"])
    }

    /// Raising the write bar must not resurrect the bare-"Untitled item" outcome:
    /// when NOTHING clears it, the title seed still names the row.
    func test_nothingClearsTheWriteBar_stillSeedsATitle() throws {
        let store = readyStore([
            "brand": .init(value: "Patagonia", confidence: 0.55, source: "photo:tag"),
            "style": .init(value: "Nano Puff", confidence: 0.6, source: "photo:front"),
        ])
        let review = try XCTUnwrap(
            store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot())
        )
        XCTAssertTrue(review.applied.isEmpty)
        XCTAssertEqual(review.lowConfidence.count, 2)

        // finish() passes this seed into write(seedTitle: true), so the row is named
        // even though no field was auto-applied.
        let seed = try XCTUnwrap(store.bestTitleSeed())
        XCTAssertEqual(seed, "Patagonia Nano Puff")
        XCTAssertEqual(
            AIItemFieldWriter.seededTitle(brand: nil, style: nil, size: nil, explicit: seed),
            "Patagonia Nano Puff"
        )
        XCTAssertTrue(review.hasSomethingToReview)
    }

    /// The pre-tick bar is what keeps the review one tap. It must sit BELOW the
    /// write bar, and the conflict/Live-Text clamps must sit below it in turn so a
    /// disagreement is never pre-accepted.
    func test_barsAreOrdered_andConflictClampsSitBelowBoth() {
        XCTAssertLessThan(
            AIExtractStore.defaultAcceptConfidenceThreshold,
            AIExtractStore.autoApplyConfidenceThreshold,
            "pre-ticking must be more permissive than writing, never the reverse"
        )
        // US-1217 / US-1530 clamps, and the US-177 Live Text stamp, are all 0.4.
        XCTAssertLessThan(
            AIExtractStore.conflictReviewConfidence,
            AIExtractStore.defaultAcceptConfidenceThreshold,
            "a conflicted field must not start ticked — the user has to choose"
        )
    }

    /// A conflicted field can never be written unasked, whatever its confidence.
    func test_conflictedField_isNeverAutoApplied() throws {
        let store = readyStore(
            ["size": .init(value: "M", confidence: 0.98, source: "photo:tag")],
            conflicts: [FieldConflict(field: "size", textValue: "L", photoValue: "M")]
        )
        let review = try XCTUnwrap(
            store.buildFillReview(itemId: "i", snapshot: AIItemFieldWriter.Snapshot())
        )
        XCTAssertTrue(review.applied.isEmpty, "a disagreement is always the user's call")
        let size = try XCTUnwrap(review.lowConfidence.first { $0.field == "size" })
        XCTAssertEqual(size.value, "L", "US-1217 prefers the tag reading as the candidate")
        XCTAssertLessThanOrEqual(size.confidence, AIExtractStore.conflictReviewConfidence)
    }

    // MARK: - condition_notes was silently dropped (US-2269)

    /// The bug: `assign` had no case for `condition_notes`, so the AI's read of the
    /// garment's condition hit the `default: break` branch. The review screen still
    /// counted it as applied, so the user was told it saved and the column never
    /// changed.
    func test_fieldUpdate_encodesConditionNotes() throws {
        var update = AIItemFieldWriter.FieldUpdate()
        XCTAssertTrue(update.assign(field: "condition_notes", value: "small pill on the left cuff"))

        let data = try JSONEncoder().encode(update)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(json["condition_notes"] as? String, "small pill on the left cuff")
        // Sparse: untouched columns must stay out of the payload entirely so a
        // fill can never clobber a column it didn't set.
        XCTAssertFalse(json.keys.contains("brand"))
        XCTAssertFalse(json.keys.contains("title"))
    }

    /// An unknown field must be reported, not swallowed. `assign` returning false
    /// is what lets `write` surface the divergence.
    func test_fieldUpdate_reportsUnmappedField() {
        var update = AIItemFieldWriter.FieldUpdate()
        XCTAssertFalse(update.assign(field: "not_a_column", value: "x"))
        XCTAssertTrue(update.assign(field: "brand", value: "Patagonia"))
    }

    /// Parity guard. Every field the extract endpoint can return has to land on a
    /// column — otherwise it is applied-in-the-review and absent-in-the-database,
    /// which is exactly how condition_notes went unnoticed. Mirrors EXTRACT_FIELDS
    /// in services/edge-functions/src/lib/ai-extract.ts.
    func test_everyServerExtractFieldMapsToAColumn() {
        XCTAssertFalse(AIItemFieldWriter.serverExtractFields.isEmpty)
        for field in AIItemFieldWriter.serverExtractFields {
            var update = AIItemFieldWriter.FieldUpdate()
            XCTAssertTrue(
                update.assign(field: field, value: "v"),
                "server field '\(field)' has no FieldUpdate column — it would be dropped silently"
            )
        }
    }

    /// Undo restores the PRIOR value, so the snapshot has to read the column too.
    /// Without this, undoing an AI-written condition note left the AI's text in
    /// place (the revert would have nothing to restore).
    func test_snapshot_roundTripsConditionNotes() throws {
        let json = #"""
        {"title":"Tee","condition_notes":"tiny mark on hem","brand":"Nike"}
        """#
        let snapshot = try JSONDecoder().decode(
            AIItemFieldWriter.Snapshot.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(snapshot.conditionNotes, "tiny mark on hem")
        XCTAssertEqual(snapshot.value(for: "condition_notes"), "tiny mark on hem")
        XCTAssertNil(snapshot.value(for: "not_a_column"))
    }

    // MARK: - Complete with AI: re-run from persisted photos (US-2266)

    /// The tag photo is the one the AI reads brand/size/material off, and on iOS
    /// it lives in the PRIVATE bucket with NO public URL — so a re-run has to sign
    /// it. Non-listable types must never reach an AI pass (US-1549 / US-1571).
    func test_rerunPhotos_signsPrivateTagAndDropsNonListable() async {
        var signed: [String] = []
        let signer: AIRerunPhotos.Signer = { bucket, path in
            signed.append("\(bucket)/\(path)")
            return URL(string: "https://api.gradethread.com/sign/\(path)?token=jwt")
        }

        let refs = [
            PersistedPhotoRef(photoType: "front", storagePath: "o/i/front.jpg", photoURL: "https://pub/front.jpg"),
            // Private: empty photoURL is exactly how iOS marks a private object.
            PersistedPhotoRef(photoType: "tag", storagePath: "o/i/tag.jpg", photoURL: ""),
            // US-1549: the seller's price tag / receipt. Never fed to AI.
            PersistedPhotoRef(photoType: "internal", storagePath: "o/i/cost.jpg", photoURL: "https://pub/cost.jpg"),
            // US-1571: the MeasureCard calibration frame.
            PersistedPhotoRef(photoType: "measurement", storagePath: "o/i/card.jpg", photoURL: "https://pub/card.jpg"),
        ]

        let out = await AIRerunPhotos.build(from: refs, signer: signer)

        XCTAssertEqual(out.map(\.type), ["front", "tag"])
        XCTAssertEqual(out[0].url, "https://pub/front.jpg")
        XCTAssertTrue(out[1].url.contains("/sign/"), "the tag must be sent as a signed URL")
        // Only the private object was signed — a public photo costs no round trip.
        XCTAssertEqual(signed, ["submission-images/o/i/tag.jpg"])
    }

    /// A sensitive type whose bytes are PUBLIC (web uploaded every type to
    /// item-photos, and so did pre-US-979 iOS builds) keeps its stored URL rather
    /// than being signed against a bucket it isn't in.
    func test_rerunPhotos_sensitiveTypeWithPublicBytesUsesStoredUrl() async {
        var signCalls = 0
        let signer: AIRerunPhotos.Signer = { _, _ in
            signCalls += 1
            return nil
        }
        let refs = [
            PersistedPhotoRef(photoType: "tag", storagePath: "o/i/tag.jpg", photoURL: "https://pub/tag.jpg"),
        ]
        let out = await AIRerunPhotos.build(from: refs, signer: signer)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].url, "https://pub/tag.jpg")
        XCTAssertEqual(signCalls, 0)
    }

    /// Order is load-bearing: the server caps the set at 8 photos by taking the
    /// FIRST 8, so the canvas passes them in sort_order and front/back/tag must
    /// stay at the front. An unresolvable row is dropped, never sent as a URL that
    /// would 404 (the server skips a non-2xx image with only a log line).
    func test_rerunPhotos_preservesOrderAndDropsUnresolvable() async {
        let signer: AIRerunPhotos.Signer = { _, _ in nil }   // signing always fails
        let refs = [
            PersistedPhotoRef(photoType: "front", storagePath: "p1", photoURL: "https://pub/1"),
            PersistedPhotoRef(photoType: "tag", storagePath: "p2", photoURL: ""),      // unsignable
            PersistedPhotoRef(photoType: "back", storagePath: "p3", photoURL: "https://pub/3"),
            PersistedPhotoRef(photoType: "detail", storagePath: nil, photoURL: ""),    // nothing to go on
        ]
        let out = await AIRerunPhotos.build(from: refs, signer: signer)
        XCTAssertEqual(out.map(\.type), ["front", "back"])
        XCTAssertEqual(out.map(\.url), ["https://pub/1", "https://pub/3"])
    }

    /// The wire contract the re-run depends on: `item_id` (the server 404s a
    /// foreign one before spending any AI) plus a non-empty typed photos array.
    func test_rerunRequest_carriesItemIdAndPhotosFromPersistedRows() async throws {
        let signer: AIRerunPhotos.Signer = { _, path in
            URL(string: "https://api.gradethread.com/sign/\(path)?token=jwt")
        }
        let refs = [
            PersistedPhotoRef(photoType: "front", storagePath: "o/i/front.jpg", photoURL: "https://pub/front.jpg"),
            PersistedPhotoRef(photoType: "tag", storagePath: "o/i/tag.jpg", photoURL: ""),
        ]
        let photos = await AIRerunPhotos.build(from: refs, signer: signer)
        let request = AIExtractRequest(
            itemId: "item-42",
            photos: photos,
            knownFields: ["brand": .string("Nike"), "size": .string("L")],
            text: "Nike windbreaker, small mark on the left cuff"
        )

        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(json["item_id"] as? String, "item-42")
        let sent = try XCTUnwrap(json["photos"] as? [[String: Any]])
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent.map { $0["type"] as? String }, ["front", "tag"])
        XCTAssertFalse((sent[1]["url"] as? String ?? "").isEmpty)

        // known_fields is what stops the server contradicting the seller: the
        // extract route deletes every known key from its suggestions.
        let known = try XCTUnwrap(json["known_fields"] as? [String: Any])
        XCTAssertEqual(known["brand"] as? String, "Nike")
        XCTAssertEqual(known["size"] as? String, "L")
        XCTAssertFalse((json["text"] as? String ?? "").isEmpty)
    }

    /// A double tap must not spend two AI actions. The guard is `tasks[itemId] ==
    /// nil`, so a second call while one is in flight has to be a no-op.
    func test_startRerun_isIdempotentWhileInFlight() {
        let mgr = AIExtractionManager.shared
        let id = "rerun-idem-\(UUID().uuidString)"
        mgr.clear(for: id)
        let before = mgr.inFlightCount

        let refs = [
            PersistedPhotoRef(photoType: "front", storagePath: "p1", photoURL: "https://pub/1"),
        ]
        // isOffline short-circuits inside the task, so nothing hits the network.
        mgr.startRerun(itemId: id, photos: refs, knownFields: nil, text: nil, isOffline: true)
        mgr.startRerun(itemId: id, photos: refs, knownFields: nil, text: nil, isOffline: true)

        XCTAssertEqual(mgr.inFlightCount, before + 1, "the second call must be a no-op")
        XCTAssertTrue(mgr.isRunning(id))
        mgr.clear(for: id)
        XCTAssertFalse(mgr.isRunning(id))
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
        // ai_field_sources is NOT NULL DEFAULT '{}' — cleared to an empty object,
        // never SQL NULL (which would violate the constraint).
        XCTAssertEqual((json["ai_field_sources"] as? [String: Any])?.isEmpty, true)
        XCTAssertFalse(json["ai_field_sources"] is NSNull)
        XCTAssertTrue(json["ai_enriched_at"] is NSNull)
    }
}
