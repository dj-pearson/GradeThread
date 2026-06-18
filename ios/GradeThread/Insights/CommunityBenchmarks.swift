import Foundation

/// US-1064: Decodable mirror of the `community_benchmarks` RPC payload
/// (migration 00173) plus the pure recommendation-derivation layer that turns
/// those anonymized, k-anonymous cohort aggregates into actionable
/// "source more of X" / "price X near $Y" suggestions.
///
/// This is the iOS twin of the web `src/lib/community-recommendations.ts` — the
/// thresholds, confidence model, and copy are deliberately kept in sync so a
/// reseller sees the same guidance on both surfaces. Pure value types with no
/// SwiftUI/network dependency so the math is unit-testable.

// MARK: - RPC payload

struct CommunityBenchmarks: Decodable, Equatable {
    var topBrands: [BrandBenchmark]
    var trendingCategories: [CategoryTrend]
    var you: SellerSummary

    enum CodingKeys: String, CodingKey {
        case topBrands, trendingCategories, you
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        topBrands = (try? c.decode([BrandBenchmark].self, forKey: .topBrands)) ?? []
        trendingCategories =
            (try? c.decode([CategoryTrend].self, forKey: .trendingCategories)) ?? []
        you = (try? c.decode(SellerSummary.self, forKey: .you))
            ?? SellerSummary(listed: 0, sold: 0, sellThrough: nil)
    }

    init(
        topBrands: [BrandBenchmark],
        trendingCategories: [CategoryTrend],
        you: SellerSummary
    ) {
        self.topBrands = topBrands
        self.trendingCategories = trendingCategories
        self.you = you
    }
}

struct BrandBenchmark: Decodable, Equatable {
    var brand: String
    var sellers: Int
    var listed: Int
    var sold: Int
    var sellThrough: Double?
    var avgSalePrice: Double?
}

struct CategoryTrend: Decodable, Equatable {
    var category: String
    var sellers: Int
    var soldRecent: Int
    var soldPrevious: Int
    var growth: Double?
}

struct SellerSummary: Decodable, Equatable {
    var listed: Int
    var sold: Int
    var sellThrough: Double?
}

// MARK: - Recommendations

enum RecommendationKind: String, Equatable {
    case source
    case price
}

enum ConfidenceLevel: String, Equatable {
    case high
    case medium
    case low

    var label: String {
        switch self {
        case .high:   return "High confidence"
        case .medium: return "Medium confidence"
        case .low:    return "Low confidence"
        }
    }
}

struct CommunityRecommendation: Identifiable, Equatable {
    let id: String
    let kind: RecommendationKind
    /// The brand or category the recommendation is about.
    let subject: String
    let title: String
    let detail: String
    /// 0–1 confidence from cohort size + signal strength.
    let confidence: Double
    let confidenceLevel: ConfidenceLevel
    /// Distinct sellers behind the cohort.
    let cohortSize: Int
    /// Brand to deep-link a filtered inventory view to (nil for category recs,
    /// since the local item mirror has no category column to filter on).
    let brandFilter: String?
    /// Internal ranking score; higher first.
    let score: Double
}

enum CommunityRecommendations {

    /// Minimum community sell-through before suggesting sourcing more of a brand.
    static let sourceSellThroughFloor = 0.5
    /// Minimum 30d-over-30d growth before a category is "demand rising".
    static let trendingGrowthFloor = 0.15

    private static func clamp(_ n: Double, _ lo: Double, _ hi: Double) -> Double {
        min(hi, max(lo, n))
    }

    /// Confidence from sample size alone. The RPC's k-anonymity floor is 5
    /// distinct sellers → 0.40, climbing to a 0.95 cap by ~23 sellers.
    static func cohortConfidence(sellers: Int) -> Double {
        clamp(0.4 + Double(sellers - 5) * 0.03, 0.4, 0.95)
    }

    static func confidenceLevel(_ confidence: Double) -> ConfidenceLevel {
        if confidence >= 0.75 { return .high }
        if confidence >= 0.55 { return .medium }
        return .low
    }

    private static func pct(_ n: Double) -> String { "\(Int((n * 100).rounded()))%" }
    private static func usd(_ n: Double) -> String { String(format: "$%.2f", n) }

    private static func brandSourceRec(_ b: BrandBenchmark) -> CommunityRecommendation? {
        guard let st = b.sellThrough, st >= sourceSellThroughFloor else { return nil }
        let confidence = clamp(
            cohortConfidence(sellers: b.sellers) * (0.6 + 0.4 * min(st, 1)), 0, 1
        )
        let avg = b.avgSalePrice.map { " · avg sale \(usd($0))" } ?? ""
        return CommunityRecommendation(
            id: "source-brand:\(b.brand)",
            kind: .source,
            subject: b.brand,
            title: "Source more \(b.brand)",
            detail: "Sells through at \(pct(st)) across \(b.sellers) sellers\(avg)",
            confidence: confidence,
            confidenceLevel: confidenceLevel(confidence),
            cohortSize: b.sellers,
            brandFilter: b.brand,
            score: st * confidence
        )
    }

    private static func brandPriceRec(_ b: BrandBenchmark) -> CommunityRecommendation? {
        guard let avg = b.avgSalePrice, avg > 0 else { return nil }
        let confidence = cohortConfidence(sellers: b.sellers)
        let st = b.sellThrough.map { " · \(pct($0)) sell-through" } ?? ""
        return CommunityRecommendation(
            id: "price-brand:\(b.brand)",
            kind: .price,
            subject: b.brand,
            title: "Price \(b.brand) near \(usd(avg))",
            detail: "Community average sale across \(b.sellers) sellers\(st)",
            confidence: confidence,
            confidenceLevel: confidenceLevel(confidence),
            cohortSize: b.sellers,
            brandFilter: b.brand,
            score: confidence
        )
    }

    private static func categorySourceRec(_ c: CategoryTrend) -> CommunityRecommendation? {
        guard let growth = c.growth, growth >= trendingGrowthFloor else { return nil }
        let confidence = clamp(
            cohortConfidence(sellers: c.sellers) * (0.7 + 0.3 * min(growth, 1)), 0, 1
        )
        return CommunityRecommendation(
            id: "source-category:\(c.category)",
            kind: .source,
            subject: c.category,
            title: "Demand rising in \(c.category)",
            detail: "Sales up \(pct(growth)) over the last 30 days · \(c.sellers) sellers",
            confidence: confidence,
            confidenceLevel: confidenceLevel(confidence),
            cohortSize: c.sellers,
            brandFilter: nil,
            score: growth * confidence
        )
    }

    /// Ranked sourcing & pricing recommendations, highest score first.
    static func derive(_ data: CommunityBenchmarks) -> [CommunityRecommendation] {
        var recs: [CommunityRecommendation] = []
        for b in data.topBrands {
            if let s = brandSourceRec(b) { recs.append(s) }
            if let p = brandPriceRec(b) { recs.append(p) }
        }
        for c in data.trendingCategories {
            if let r = categorySourceRec(c) { recs.append(r) }
        }
        return recs.sorted { $0.score > $1.score }
    }
}
