import XCTest
@testable import GradeThread

/// US-1064: the pure recommendation-derivation layer over community benchmarks.
/// Mirrors the web `community-recommendations.test.ts` so the two surfaces stay
/// in lockstep.
final class CommunityRecommendationsTests: XCTestCase {

    private func benchmarks(
        brands: [BrandBenchmark] = [],
        categories: [CategoryTrend] = []
    ) -> CommunityBenchmarks {
        CommunityBenchmarks(
            topBrands: brands,
            trendingCategories: categories,
            you: SellerSummary(listed: 0, sold: 0, sellThrough: nil)
        )
    }

    func testCohortConfidenceFloorsAndClimbs() {
        XCTAssertEqual(CommunityRecommendations.cohortConfidence(sellers: 5), 0.4, accuracy: 1e-9)
        XCTAssertEqual(CommunityRecommendations.cohortConfidence(sellers: 20), 0.85, accuracy: 1e-9)
        XCTAssertEqual(CommunityRecommendations.cohortConfidence(sellers: 100), 0.95, accuracy: 1e-9)
        XCTAssertEqual(CommunityRecommendations.cohortConfidence(sellers: 0), 0.4, accuracy: 1e-9)
    }

    func testConfidenceLevelBuckets() {
        XCTAssertEqual(CommunityRecommendations.confidenceLevel(0.8), .high)
        XCTAssertEqual(CommunityRecommendations.confidenceLevel(0.6), .medium)
        XCTAssertEqual(CommunityRecommendations.confidenceLevel(0.5), .low)
    }

    func testSourceAndPriceForHighSellThroughBrand() {
        let recs = CommunityRecommendations.derive(
            benchmarks(brands: [
                BrandBenchmark(
                    brand: "Patagonia", sellers: 20, listed: 100, sold: 80,
                    sellThrough: 0.8, avgSalePrice: 65
                )
            ])
        )
        let source = recs.first { $0.kind == .source }
        let price = recs.first { $0.kind == .price }
        XCTAssertNotNil(source)
        XCTAssertEqual(source?.subject, "Patagonia")
        XCTAssertEqual(source?.cohortSize, 20)
        XCTAssertEqual(source?.brandFilter, "Patagonia")
        XCTAssertNotNil(price)
        XCTAssertTrue(price?.title.contains("$65.00") ?? false)
    }

    func testNoSourceRecForLowSellThrough() {
        let recs = CommunityRecommendations.derive(
            benchmarks(brands: [
                BrandBenchmark(
                    brand: "Slowmover", sellers: 12, listed: 100, sold: 20,
                    sellThrough: 0.2, avgSalePrice: 30
                )
            ])
        )
        XCTAssertFalse(recs.contains { $0.kind == .source })
        XCTAssertTrue(recs.contains { $0.kind == .price })
    }

    func testRisingCategorySurfacesAndFlatSkips() {
        let recs = CommunityRecommendations.derive(
            benchmarks(categories: [
                CategoryTrend(
                    category: "outerwear", sellers: 15, soldRecent: 60,
                    soldPrevious: 30, growth: 1.0
                ),
                CategoryTrend(
                    category: "tops", sellers: 10, soldRecent: 31,
                    soldPrevious: 30, growth: 0.03
                )
            ])
        )
        XCTAssertEqual(recs.filter { $0.subject == "outerwear" }.count, 1)
        XCTAssertFalse(recs.contains { $0.subject == "tops" })
        // Category recs have no brand filter (local mirror has no category column).
        XCTAssertNil(recs.first { $0.subject == "outerwear" }?.brandFilter)
    }

    func testRanksStrongSignalFirst() {
        let recs = CommunityRecommendations.derive(
            benchmarks(brands: [
                BrandBenchmark(
                    brand: "Weak", sellers: 5, listed: 10, sold: 6,
                    sellThrough: 0.6, avgSalePrice: 20
                ),
                BrandBenchmark(
                    brand: "Strong", sellers: 25, listed: 100, sold: 95,
                    sellThrough: 0.95, avgSalePrice: 80
                )
            ])
        )
        XCTAssertEqual(recs.first?.subject, "Strong")
    }

    func testEmptyWhenNoQualifyingCohorts() {
        XCTAssertTrue(CommunityRecommendations.derive(benchmarks()).isEmpty)
    }

    func testDecodesRpcPayload() throws {
        let json = """
        {
          "meta": { "minSellers": 5, "periodStart": null, "generatedAt": "2026-06-18" },
          "topBrands": [
            { "brand": "Nike", "sellers": 8, "listed": 40, "sold": 24, "sellThrough": 0.6, "avgSalePrice": 42.5 }
          ],
          "trendingCategories": [
            { "category": "shoes", "sellers": 6, "soldRecent": 20, "soldPrevious": 10, "growth": 1.0 }
          ],
          "you": { "listed": 3, "sold": 1, "sellThrough": 0.33, "peerComparison": null }
        }
        """
        let data = Data(json.utf8)
        let decoded = try JSONDecoder().decode(CommunityBenchmarks.self, from: data)
        XCTAssertEqual(decoded.topBrands.first?.brand, "Nike")
        XCTAssertEqual(decoded.trendingCategories.first?.category, "shoes")
        XCTAssertEqual(decoded.you.listed, 3)
        XCTAssertFalse(CommunityRecommendations.derive(decoded).isEmpty)
    }
}
