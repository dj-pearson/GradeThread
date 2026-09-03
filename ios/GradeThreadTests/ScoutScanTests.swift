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
            result: .success(ScoutScanResponse(scanned: 1, candidates: [makeCandidate(id: "x", margin: 100)], disclaimer: "d",
                              note: nil, considered: 1, graded: 1))
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
            result: .success(ScoutScanResponse(scanned: 0, candidates: [], disclaimer: nil, note: "none",
                              considered: 0, graded: 0))
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

    // MARK: - US-3097: basis, affiliate url, and Bought it

    func test_decodesValueBasisAndAffiliateURL() throws {
        // Both fields are optional on the wire. `url` is nil until US-3082
        // ships, and `valueBasis` is nil on a response built before US-2850 —
        // neither may break the decode, or a scan returns nothing at all.
        let json = #"""
        {"scanned":1,"candidates":[
          {"itemId":"v1","title":"Arc'teryx Beta AR","imageUrl":null,
           "itemWebUrl":"https://www.ebay.com/itm/1","askingCents":6200,
           "shadowGrade":8.0,"gradeConfidence":0.8,"valueLowCents":12000,
           "valueMedianCents":15000,"valueHighCents":18000,"estMarginCents":6000,
           "estMarginPct":0.97,"underpriced":true,"actionable":true,
           "reason":"Underpriced for its condition",
           "url":"https://www.ebay.com/itm/1?mkcid=1&campid=5339154788",
           "valueBasis":{"source":"measured_curve","prices":"active_asking",
             "sampleSize":42,"slopeCentsPerPoint":800,
             "slopeShape":"rises_with_condition","measuredAt":"2026-09-01T00:00:00Z",
             "headline":"Measured from 42 listings","detail":"Prices are what sellers are asking."}}
        ]}
        """#
        let r = try JSONDecoder().decode(ScoutScanResponse.self, from: Data(json.utf8))
        let c = try XCTUnwrap(r.candidates.first)
        XCTAssertEqual(c.valueBasis?.headline, "Measured from 42 listings")
        XCTAssertEqual(c.valueBasis?.source, "measured_curve")
        XCTAssertEqual(c.valueBasis?.sampleSize, 42)
        XCTAssertEqual(
            c.outboundURL?.absoluteString,
            "https://www.ebay.com/itm/1?mkcid=1&campid=5339154788",
            "the affiliate URL must win, or the commission is never credited"
        )
    }

    func test_boughtItWritesTheAskingPriceAsTheCostBasis() async throws {
        let candidate = makeCandidate(id: "v1", margin: 6000)
        let service = FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 1, candidates: [candidate], disclaimer: nil, note: nil,
                              considered: 1, graded: 1))
        )
        let store = ScoutStore(service: service)

        await store.buy(candidate)

        XCTAssertEqual(service.buyCalls.count, 1)
        let request = try XCTUnwrap(service.buyCalls.first)
        XCTAssertEqual(request.title, candidate.title)
        XCTAssertEqual(
            request.costCents, candidate.askingCents,
            "the asking price IS the cost basis — it is what the flipper hands over"
        )
        XCTAssertEqual(
            request.targetCents, candidate.valueMedianCents,
            "the item lands carrying the number Scout just worked out"
        )
        XCTAssertEqual(request.gradeValue, candidate.shadowGrade)
        XCTAssertEqual(store.boughtItemIds["v1"], "item-1")
        XCTAssertNil(store.buyError)
    }

    func test_boughtItIsIdempotentPerCandidate() async {
        // A second tap on a row already committed would write a second
        // inventory item for one garment, and the seller finds the duplicate
        // days later with no way to tell which one is real.
        let candidate = makeCandidate(id: "v1")
        let service = FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 1, candidates: [candidate], disclaimer: nil, note: nil,
                              considered: 1, graded: 1))
        )
        let store = ScoutStore(service: service)

        await store.buy(candidate)
        await store.buy(candidate)

        XCTAssertEqual(service.buyCalls.count, 1, "the second tap must be refused")
    }

    func test_boughtItSurfacesAFailureAndStaysBuyable() async {
        let candidate = makeCandidate(id: "v1")
        let service = FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 1, candidates: [candidate], disclaimer: nil, note: nil,
                              considered: 1, graded: 1))
        )
        service.buyResult = .failure(EdgeAPIError.network("offline"))
        let store = ScoutStore(service: service)

        await store.buy(candidate)

        XCTAssertNotNil(store.buyError)
        XCTAssertNil(
            store.boughtItemIds["v1"],
            "a failed buy must not mark the row added — the seller would think it was recorded"
        )
    }

    // MARK: - US-3098: the deal filter

    func test_blankFiltersSendNothingAtAll() async {
        // A scan with no filter set must send exactly the body it always did,
        // or every request is a new one to the server and to any cache.
        let service = FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 0, candidates: [], disclaimer: nil,
                                               note: nil, considered: 0, graded: 0))
        )
        let store = ScoutStore(service: service)
        store.clearFilters()
        store.keyword = "patagonia"

        await store.scan()

        let request = service.lastRequest
        XCTAssertNil(request?.maxTotalCents)
        XCTAssertNil(request?.minMarginCents)
        XCTAssertNil(request?.minMarginPct)
        XCTAssertNil(request?.buyingOptions)
        XCTAssertNil(request?.freeShippingOnly)
        XCTAssertNil(request?.sort, "bestMatch is the ABSENCE of a sort, not a value")
    }

    func test_filtersAreConvertedToTheUnitsTheRouteWants() async {
        let service = FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 0, candidates: [], disclaimer: nil,
                                               note: nil, considered: 0, graded: 0))
        )
        let store = ScoutStore(service: service)
        store.keyword = "patagonia"
        store.maxTotalText = "40"
        store.minMarginDollarsText = "20"
        store.minMarginPctText = "40"
        store.buyItNowOnly = true
        store.freeShippingOnly = true
        store.browseSort = .newlyListed

        await store.scan()

        let request = service.lastRequest
        XCTAssertEqual(request?.maxTotalCents, 4000, "dollars typed become cents")
        XCTAssertEqual(request?.minMarginCents, 2000)
        XCTAssertEqual(
            request?.minMarginPct, 0.4,
            "the field is whole percent; the wire is a fraction, and the route refuses 30"
        )
        XCTAssertEqual(
            request?.buyingOptions, ["FIXED_PRICE", "BEST_OFFER"],
            "Buy It Now means no auctions — a best-offer listing is still fixed price, and the better find"
        )
        XCTAssertEqual(request?.freeShippingOnly, true)
        XCTAssertEqual(request?.sort, "newlyListed")
    }

    func test_halfTypedAndNonsenseValuesAreNotFilters() {
        // A "4" on the way to "40" must not become a live $4 cap, and a filter
        // nobody set must never become a filter of zero.
        XCTAssertNil(ScoutStore.cents(from: ""))
        XCTAssertNil(ScoutStore.cents(from: "   "))
        XCTAssertNil(ScoutStore.cents(from: "abc"))
        XCTAssertNil(ScoutStore.cents(from: "0"))
        XCTAssertNil(ScoutStore.cents(from: "-5"))
        XCTAssertEqual(ScoutStore.cents(from: "4"), 400)
        XCTAssertEqual(ScoutStore.cents(from: "12.50"), 1250)
    }

    func test_anAbsurdPercentIsClampedRatherThanRefusedByTheServer() {
        // A seller typing 400 into "min return" means "only the real steals".
        // Sending 4.0 gets a 400 naming a field they are looking straight at.
        XCTAssertEqual(ScoutStore.fraction(fromPercent: "40"), 0.4)
        XCTAssertEqual(ScoutStore.fraction(fromPercent: "100"), 1)
        XCTAssertEqual(ScoutStore.fraction(fromPercent: "400"), 1)
        XCTAssertNil(ScoutStore.fraction(fromPercent: ""))
        XCTAssertNil(ScoutStore.fraction(fromPercent: "0"))
    }

    func test_scanSummaryNamesTheDenominator() async {
        let service = FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 8, candidates: [], disclaimer: nil,
                                               note: nil, considered: 42, graded: 8))
        )
        let store = ScoutStore(service: service)
        store.keyword = "patagonia"
        await store.scan()

        let summary = store.scanSummary
        XCTAssertNotNil(summary)
        XCTAssertTrue(summary?.contains("42") == true, "the denominator has to be in it")
        XCTAssertTrue(summary?.contains("8") == true)
    }

    func test_anOlderEdgeWithNoCountsStillReadsSensibly() async {
        // `considered` is optional on the wire; a response from before US-3098
        // must not produce "looked at 0".
        let service = FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 8, candidates: [], disclaimer: nil,
                                               note: nil, considered: nil, graded: nil))
        )
        let store = ScoutStore(service: service)
        store.keyword = "patagonia"
        await store.scan()

        XCTAssertEqual(store.scanSummary?.contains("Looked at"), false)
        XCTAssertTrue(store.scanSummary?.contains("8") == true)
    }

    func test_hasFiltersAndClearAreConsistent() {
        let store = ScoutStore(service: FakeScoutService(
            suggestion: nil,
            result: .success(ScoutScanResponse(scanned: 0, candidates: [], disclaimer: nil,
                                               note: nil, considered: 0, graded: 0))
        ))
        store.clearFilters()
        XCTAssertFalse(store.hasFilters, "a cleared store offers nothing to clear")
        store.maxTotalText = "40"
        XCTAssertTrue(store.hasFilters)
        store.clearFilters()
        XCTAssertFalse(store.hasFilters)
        XCTAssertEqual(store.maxTotalText, "")
        XCTAssertEqual(store.browseSort, .bestMatch)
    }

    func test_decodesTotalAndCeilingOnACandidate() throws {
        let json = #"""
        {"scanned":1,"considered":42,"graded":1,"candidates":[
          {"itemId":"v1","title":"Arc'teryx Beta AR","imageUrl":null,
           "itemWebUrl":"https://www.ebay.com/itm/1","askingCents":6200,
           "shadowGrade":8.0,"gradeConfidence":0.8,"valueLowCents":12000,
           "valueMedianCents":15000,"valueHighCents":18000,"estMarginCents":6000,
           "estMarginPct":0.97,"underpriced":true,"actionable":true,"reason":"x",
           "totalCents":7100,"totalIncludesShipping":true,
           "ceiling":{"maxPriceCents":9800,"targetRoi":0.3,"netResaleCents":12740,
                      "absentReason":null}}
        ]}
        """#
        let r = try JSONDecoder().decode(ScoutScanResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.considered, 42)
        XCTAssertEqual(r.graded, 1)
        let c = try XCTUnwrap(r.candidates.first)
        XCTAssertEqual(c.totalCents, 7100, "asking 62 plus 9 shipping")
        XCTAssertEqual(c.totalIncludesShipping, true)
        XCTAssertEqual(c.ceiling?.maxPriceCents, 9800)
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
            underpriced: false, actionable: actionable, reason: "",
            valueBasis: nil, totalCents: 1000, totalIncludesShipping: true,
            ceiling: nil, url: nil
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

    private(set) var lastRequest: ScoutScanRequest?

    func scan(_ request: ScoutScanRequest) async throws -> ScoutScanResponse {
        lastCategoryId = request.categoryId
        lastRequest = request
        switch result {
        case .success(let response): return response
        case .failure(let error): throw error
        }
    }

    // US-3097
    var buyResult: Result<ProspectBuyResponse, Error> = .success(
        ProspectBuyResponse(id: "item-1", status: "sourced")
    )
    private(set) var buyCalls: [ProspectBuyRequest] = []

    func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse {
        buyCalls.append(request)
        return try buyResult.get()
    }
}
