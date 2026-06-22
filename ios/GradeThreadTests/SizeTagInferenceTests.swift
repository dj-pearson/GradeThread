import XCTest
@testable import GradeThread

final class SizeTagInferenceTests: XCTestCase {

    // MARK: - Brand detection

    func test_brand_knownWhitelistHit_titleCases() {
        let lines = ["the north face", "Outdoor / Mountain Wear", "Made in Vietnam"]
        let result = SizeTagInference.infer(lines: lines)
        XCTAssertEqual(result.brand, "The North Face")
    }

    func test_brand_lowercaseAdidas_caughtByWhitelist() {
        // Adidas prints lowercase — the uppercase heuristic would miss it,
        // so the whitelist matters.
        let lines = ["adidas", "S", "100% Cotton"]
        let result = SizeTagInference.infer(lines: lines)
        XCTAssertEqual(result.brand, "Adidas")
    }

    func test_brand_whitelistMatchesWithinNoisyLine() {
        let lines = ["PATAGONIA INC", "Synchilla", "Made in USA", "L"]
        let result = SizeTagInference.infer(lines: lines)
        XCTAssertEqual(result.brand, "Patagonia") // matched inside "PATAGONIA INC"
    }

    func test_brand_styleNameIsNotReturnedAsBrand() {
        // The regression this fallback caused: a prominent uppercase COLLECTION /
        // style line (no recognizable brand present) was confidently returned as
        // the brand. Whitelist-only now returns nil rather than a style name.
        XCTAssertNil(SizeTagInference.infer(lines: ["SYNCHILLA", "SNAP-T", "Made in USA"]).brand)
        XCTAssertNil(SizeTagInference.infer(lines: ["HERITAGE", "REGULAR FIT", "Cotton"]).brand)
        XCTAssertNil(SizeTagInference.infer(lines: ["VINTAGE", "AUTHENTIC"]).brand)
    }

    func test_brand_rejectsSizeLines() {
        let lines = ["SIZE L", "MADE IN USA", "100% Cotton"]
        let result = SizeTagInference.infer(lines: lines)
        // None of these should read as a brand.
        XCTAssertNil(result.brand)
    }

    func test_brand_rejectsBareAlphaSize() {
        let lines = ["XL", "100% Cotton", "Wash Cold"]
        let result = SizeTagInference.infer(lines: lines)
        XCTAssertNil(result.brand)
    }

    // MARK: - Size detection

    func test_size_alphaTokenAlone() {
        let result = SizeTagInference.infer(lines: ["Carhartt", "XL", "Made in Mexico"])
        XCTAssertEqual(result.size, "XL")
    }

    func test_size_xxxlTokenAlone() {
        let result = SizeTagInference.infer(lines: ["Champion", "XXXL"])
        XCTAssertEqual(result.size, "XXXL")
    }

    func test_size_waistByLength_jeansFormat() {
        let result = SizeTagInference.infer(lines: ["LEVI'S", "501", "W34 L32"])
        XCTAssertEqual(result.size, "34x32")
    }

    func test_size_waistByLength_xSeparator() {
        let result = SizeTagInference.infer(lines: ["Dickies", "30 x 30"])
        XCTAssertEqual(result.size, "30x30")
    }

    func test_size_explicitSizePrefix() {
        let result = SizeTagInference.infer(lines: ["LEVI'S", "Size 12", "Slim Fit"])
        XCTAssertEqual(result.size, "12")
    }

    func test_size_explicitSizePrefix_withAlphaValue() {
        let result = SizeTagInference.infer(lines: ["Carhartt", "Size: M"])
        XCTAssertEqual(result.size, "M")
    }

    func test_size_numericSizeAlone() {
        let result = SizeTagInference.infer(lines: ["Polo Ralph Lauren", "10", "100% Cotton"])
        XCTAssertEqual(result.size, "10")
    }

    func test_size_rejectsBigNumbers() {
        // 2024 is a year, not a size — guard against capturing dates.
        let result = SizeTagInference.infer(lines: ["Brand", "2024"])
        XCTAssertNil(result.size)
    }

    func test_size_prefersWaistLengthOverAlpha() {
        // When both forms appear, the more specific waist×length wins.
        let result = SizeTagInference.infer(lines: ["LEVI'S", "M", "32 x 30"])
        XCTAssertEqual(result.size, "32x30")
    }

    // MARK: - Combined

    func test_infer_combinesBrandAndSize() {
        let lines = [
            "PATAGONIA",
            "Synchilla Snap-T",
            "Size M",
            "100% Polyester",
            "Made in Vietnam",
        ]
        let result = SizeTagInference.infer(lines: lines)
        XCTAssertEqual(result.brand, "Patagonia")
        XCTAssertEqual(result.size, "M")
    }

    func test_infer_emptyInput_returnsBothNil() {
        let result = SizeTagInference.infer(lines: [])
        XCTAssertNil(result.brand)
        XCTAssertNil(result.size)
    }

    func test_infer_whitespaceOnly_isStripped() {
        let result = SizeTagInference.infer(lines: ["   ", "\n\t", ""])
        XCTAssertNil(result.brand)
        XCTAssertNil(result.size)
    }

    // MARK: - AIExtractStore.mergeLiveTextSuggestions

    @MainActor
    func test_storeMerge_addsMissingFieldsAt0_4Confidence() {
        let store = AIExtractStore()
        // Claude returned only color — brand + size are missing.
        let response = AIExtractResponse(
            suggestions: [
                "color": .init(value: "navy", confidence: 0.9, source: "photo:front"),
            ],
            conditionSummary: nil,
            conflicts: [],
            measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        )
        store.applyResponse(response)
        XCTAssertFalse(store.liveTextFallbackUsed)

        store.mergeLiveTextSuggestions(brand: "Patagonia", size: "M")

        guard case let .ready(result) = store.phase else {
            return XCTFail("expected ready phase")
        }
        XCTAssertEqual(result.entries.count, 3)
        let brand = result.entries.first { $0.field == "brand" }
        XCTAssertEqual(brand?.value, "Patagonia")
        XCTAssertEqual(brand?.suggestion.confidence, 0.4)
        XCTAssertEqual(brand?.source, "live-text")
        XCTAssertTrue(store.liveTextFallbackUsed)
        // Fallback rows aren't auto-accepted — 0.4 < the 0.8 default
        // threshold.
        XCTAssertFalse(store.isAccepted("brand"))
        XCTAssertFalse(store.isAccepted("size"))
    }

    @MainActor
    func test_storeMerge_doesNotOverrideExistingFields() {
        let store = AIExtractStore()
        let response = AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Patagonia", confidence: 0.95, source: "photo:tag"),
            ],
            conditionSummary: nil,
            conflicts: [],
            measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        )
        store.applyResponse(response)
        // Live Text proposes a brand even though Claude already has one —
        // we should ignore that and only fill the missing field.
        store.mergeLiveTextSuggestions(brand: "WrongBrand", size: "M")

        guard case let .ready(result) = store.phase else {
            return XCTFail("expected ready phase")
        }
        let brand = result.entries.first { $0.field == "brand" }
        XCTAssertEqual(brand?.value, "Patagonia")
        XCTAssertEqual(brand?.suggestion.confidence, 0.95)
        XCTAssertTrue(result.entries.contains { $0.field == "size" })
    }

    @MainActor
    func test_storeMerge_noopWhenNoNewFields() {
        let store = AIExtractStore()
        let response = AIExtractResponse(
            suggestions: [
                "brand": .init(value: "Patagonia", confidence: 0.95, source: "photo:tag"),
                "size": .init(value: "L", confidence: 0.9, source: "photo:tag"),
            ],
            conditionSummary: nil,
            conflicts: [],
            measurements: nil,
            model: nil, logId: nil, actionsRemaining: 0
        )
        store.applyResponse(response)
        store.mergeLiveTextSuggestions(brand: "X", size: "Y")
        XCTAssertFalse(store.liveTextFallbackUsed,
                       "Fallback shouldn't activate when nothing new was added")
    }

    // MARK: - Source label

    func test_entry_sourceLabel_liveTextReadsAsOnDeviceOCR() {
        let entry = FieldSuggestionEntry(
            id: "brand",
            field: "brand",
            suggestion: FieldSuggestion(value: "Patagonia", confidence: 0.4, source: "live-text")
        )
        XCTAssertEqual(entry.sourceLabel, "On-device OCR")
    }
}
