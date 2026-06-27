import XCTest
@testable import GradeThread

@MainActor
final class CompsTests: XCTestCase {

    // MARK: - Decoding

    func test_decodesCompStats_fromFullResponse() throws {
        let json = #"""
        {"items":[],"total":12,"stats":{"count":12,"currency":"USD",
         "min":10.0,"p25":15.0,"median":22.5,"p75":30.0,"max":80.0}}
        """#
        let r = try JSONDecoder().decode(CompsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.stats.count, 12)
        XCTAssertEqual(r.stats.median, 22.5)
        XCTAssertEqual(r.stats.min, 10)
        XCTAssertEqual(r.stats.max, 80)
    }

    func test_decodesCompStats_withNullPercentiles() throws {
        let json = #"""
        {"stats":{"count":0,"currency":"USD","min":null,"p25":null,
         "median":null,"p75":null,"max":null}}
        """#
        let r = try JSONDecoder().decode(CompsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.stats.count, 0)
        XCTAssertNil(r.stats.median)
        XCTAssertNil(r.stats.min)
    }

    func test_decodesCategorySuggestions() throws {
        let json = #"""
        {"suggestions":[
          {"categoryId":"57988","categoryName":"Blazers",
           "categoryTreePath":"Clothing › Men › Blazers"}
        ]}
        """#
        let r = try JSONDecoder().decode(CategorySuggestResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.suggestions.first?.categoryId, "57988")
        XCTAssertEqual(r.suggestions.first?.categoryTreePath, "Clothing › Men › Blazers")
    }

    // MARK: - Store phase transitions

    func test_store_success_setsLoaded() async {
        let lookup = makeLookup(count: 3, median: 12)
        let store = CompsStore(service: FakeCompsProvider(result: .success(lookup)))
        await store.fetch(title: "Levi's 501", brand: "Levi's", size: "32")
        XCTAssertEqual(store.phase, .loaded(lookup))
    }

    func test_store_nilLookup_setsFailed() async {
        let store = CompsStore(service: FakeCompsProvider(result: .success(nil)))
        await store.fetch(title: "x", brand: nil, size: nil)
        guard case .failed = store.phase else {
            XCTFail("Expected .failed, got \(store.phase)"); return
        }
    }

    func test_store_throwing_setsFailedWithMessage() async {
        let store = CompsStore(service: FakeCompsProvider(result: .failure(EdgeAPIError.rateLimited())))
        await store.fetch(title: "x", brand: nil, size: nil)
        guard case .failed(let message) = store.phase else {
            XCTFail("Expected .failed, got \(store.phase)"); return
        }
        XCTAssertFalse(message.isEmpty)
    }

    // MARK: - Helpers

    private func makeLookup(count: Int, median: Double?) -> CompsLookup {
        CompsLookup(
            stats: CompStats(
                count: count, currency: "USD",
                min: 5, p25: 8, median: median, p75: 18, max: 25
            ),
            categoryId: "1",
            categoryPath: "Clothing › Test"
        )
    }
}

/// Deterministic stand-in for ``CompsService`` so the store's phase logic is
/// tested without touching the network.
@MainActor
private final class FakeCompsProvider: CompsProviding {
    enum Outcome {
        case success(CompsLookup?)
        case failure(Error)
    }

    let result: Outcome
    init(result: Outcome) { self.result = result }

    func lookup(title: String, brand: String?, size: String?) async throws -> CompsLookup? {
        switch result {
        case .success(let lookup): return lookup
        case .failure(let error): throw error
        }
    }
}
