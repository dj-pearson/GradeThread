import XCTest
@testable import GradeThread

@MainActor
final class ScoutScanTests: XCTestCase {

    // MARK: - Decoding (plain decoder, camelCase keys)

    func test_decodesScanResponse() throws {
        let json = #"""
        {"scanned":2,"disclaimer":"private estimate",
         "candidates":[
           {"itemId":"v1","title":"Patagonia Better Sweater","imageUrl":"https://img/1.jpg",
            "itemWebUrl":"https://ebay/1","askingCents":2500,"shadowGrade":8.5,
            "gradeConfidence":0.82,"valueLowCents":4000,"valueMedianCents":5000,
            "valueHighCents":6000,"estMarginCents":1850,"estMarginPct":0.74,
            "underpriced":true,"actionable":true,"reason":"Underpriced for its condition"},
           {"itemId":"v2","title":"Worn tee","imageUrl":null,"itemWebUrl":null,
            "askingCents":null,"shadowGrade":null,"gradeConfidence":0.3,
            "valueLowCents":null,"valueMedianCents":null,"valueHighCents":null,
            "estMarginCents":null,"estMarginPct":null,
            "underpriced":false,"actionable":false,"reason":"No asking price available."}
         ]}
        """#
        let r = try JSONDecoder().decode(ScoutScanResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.scanned, 2)
        XCTAssertEqual(r.candidates.count, 2)
        let first = r.candidates[0]
        XCTAssertEqual(first.itemId, "v1")
        XCTAssertEqual(first.shadowGrade, 8.5)
        XCTAssertEqual(first.estMarginCents, 1850)
        XCTAssertTrue(first.underpriced)
        // Nullable fields decode to nil rather than throwing.
        XCTAssertNil(r.candidates[1].askingCents)
        XCTAssertNil(r.candidates[1].shadowGrade)
    }

    func test_decodesEmptyResultWithNote() throws {
        let json = #"{"candidates":[],"scanned":0,"note":"No candidate listings matched that search."}"#
        let r = try JSONDecoder().decode(ScoutScanResponse.self, from: Data(json.utf8))
        XCTAssertTrue(r.candidates.isEmpty)
        XCTAssertEqual(r.note, "No candidate listings matched that search.")
        XCTAssertNil(r.disclaimer)
    }

    // MARK: - Display ordering + filtering (pure)

    func test_display_sortsByMargin_nilLast() {
        let a = makeCandidate(id: "a", margin: 500)
        let b = makeCandidate(id: "b", margin: 1500)
        let c = makeCandidate(id: "c", margin: nil)
        let out = ScoutStore.display([a, b, c], sortKey: .margin, actionableOnly: false)
        XCTAssertEqual(out.map(\.id), ["b", "a", "c"])
    }

    func test_display_sortsByGrade_thenConfidence() {
        let a = makeCandidate(id: "a", grade: 6.0, confidence: 0.9)
        let b = makeCandidate(id: "b", grade: 9.0, confidence: 0.5)
        let c = makeCandidate(id: "c", grade: nil, confidence: 0.99)

        XCTAssertEqual(
            ScoutStore.display([a, b, c], sortKey: .grade, actionableOnly: false).map(\.id),
            ["b", "a", "c"]
        )
        XCTAssertEqual(
            ScoutStore.display([a, b, c], sortKey: .confidence, actionableOnly: false).map(\.id),
            ["c", "a", "b"]
        )
    }

    func test_display_actionableOnly_filters() {
        let a = makeCandidate(id: "a", margin: 100, actionable: true)
        let b = makeCandidate(id: "b", margin: 200, actionable: false)
        let out = ScoutStore.display([a, b], sortKey: .margin, actionableOnly: true)
        XCTAssertEqual(out.map(\.id), ["a"])
    }

    // MARK: - Formatting

    func test_dollars_formatsCents() {
        XCTAssertEqual(ScoutCandidateRow.dollars(2500), "$25.00")
        XCTAssertEqual(ScoutCandidateRow.dollars(1999), "$19.99")
        XCTAssertEqual(ScoutCandidateRow.dollars(nil), "—")
    }

    func test_gradeText_and_color() {
        XCTAssertEqual(ScoutCandidateRow.gradeText(8.5), "8.5")
        XCTAssertEqual(ScoutCandidateRow.gradeText(nil), "—")
    }

    // MARK: - Store scan flow (faked service)

    func test_scan_resolvesCategory_andSetsResponse() async {
        let suggestion = CategorySuggestion(
            categoryId: "57988", categoryName: "Blazers", categoryTreePath: "Clothing › Blazers"
        )
        let fake = FakeScoutService(
            suggestion: suggestion,
            result: .success(ScoutScanResponse(scanned: 1, candidates: [makeCandidate(id: "x", margin: 100)], disclaimer: "d", note: nil))
        )
        let store = ScoutStore(service: fake)
        store.keyword = "wool blazer"

        await store.scan()

        XCTAssertEqual(fake.lastCategoryId, "57988", "should scan within the resolved category")
        XCTAssertEqual(store.resolvedCategory, suggestion)
        XCTAssertEqual(store.categoryLabel, "Blazers")
        XCTAssertEqual(store.response?.candidates.count, 1)
        XCTAssertNil(store.errorMessage)
    }

    func test_scan_fallsBackToApparelRoot_whenNoSuggestion() async {
        let fake = FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 0, candidates: [], disclaimer: nil, note: "none"))
        )
        let store = ScoutStore(service: fake)
        store.brand = "Nike"

        await store.scan()

        XCTAssertEqual(fake.lastCategoryId, ScoutStore.apparelRootId)
        XCTAssertNil(store.resolvedCategory)
        XCTAssertEqual(store.categoryLabel, ScoutStore.apparelRootName)
    }

    func test_scan_surfacesError() async {
        let fake = FakeScoutService(suggestion: nil, result: .failure(EdgeAPIError.rateLimited()))
        let store = ScoutStore(service: fake)
        store.keyword = "x"
        await store.scan()
        XCTAssertNil(store.response)
        XCTAssertEqual(store.errorMessage, EdgeAPIError.rateLimited().errorDescription)
    }

    func test_canSearch_requiresKeywordOrBrand() {
        let store = ScoutStore(service: FakeScoutService(suggestion: nil, result: .success(.init(scanned: 0, candidates: [], disclaimer: nil, note: nil))))
        XCTAssertFalse(store.canSearch)
        store.keyword = "   "
        XCTAssertFalse(store.canSearch, "whitespace doesn't count")
        store.brand = "Nike"
        XCTAssertTrue(store.canSearch)
    }

    // MARK: - Helpers

    private func makeCandidate(
        id: String,
        margin: Int? = nil,
        grade: Double? = 7.0,
        confidence: Double = 0.8,
        actionable: Bool = true
    ) -> ScoutCandidate {
        ScoutCandidate(
            itemId: id, title: "Item \(id)", imageUrl: nil, itemWebUrl: nil,
            askingCents: 1000, shadowGrade: grade, gradeConfidence: confidence,
            valueLowCents: 1500, valueMedianCents: 2000, valueHighCents: 2500,
            estMarginCents: margin, estMarginPct: margin.map { Double($0) / 1000 },
            underpriced: false, actionable: actionable, reason: ""
        )
    }
}

/// Deterministic stand-in for ``ScoutService``.
@MainActor
private final class FakeScoutService: ScoutScanning {
    enum Outcome {
        case success(ScoutScanResponse)
        case failure(Error)
    }

    let suggestion: CategorySuggestion?
    let result: Outcome
    private(set) var lastCategoryId: String?

    init(suggestion: CategorySuggestion?, result: Outcome) {
        self.suggestion = suggestion
        self.result = result
    }

    func suggestCategory(for query: String) async throws -> CategorySuggestion? {
        suggestion
    }

    func scan(categoryId: String, q: String?, brand: String?, limit: Int) async throws -> ScoutScanResponse {
        lastCategoryId = categoryId
        switch result {
        case .success(let response): return response
        case .failure(let error): throw error
        }
    }
}
