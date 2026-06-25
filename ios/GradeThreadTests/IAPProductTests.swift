import XCTest
@testable import GradeThread

/// Pure IAP catalog. Product ids + shape must mirror the server PRODUCT_MAP.
final class IAPProductTests: XCTestCase {

    func test_classify_subscriptions() {
        XCTAssertEqual(
            IAPCatalog.classify("com.gradethread.sub.pro.monthly"),
            .subscription(plan: "pro", interval: "monthly"))
        XCTAssertEqual(
            IAPCatalog.classify("com.gradethread.sub.business.yearly"),
            .subscription(plan: "business", interval: "yearly"))
    }

    func test_classify_consumables() {
        XCTAssertEqual(IAPCatalog.classify("com.gradethread.credits.50"), .consumable(credits: 50))
    }

    func test_classify_failsClosed() {
        XCTAssertNil(IAPCatalog.classify("com.gradethread.sub.enterprise.monthly"))
        XCTAssertNil(IAPCatalog.classify(""))
    }

    func test_catalog_shape() {
        XCTAssertEqual(IAPCatalog.allIds.count, 10)
        XCTAssertEqual(IAPCatalog.consumables.count, 4)
        XCTAssertEqual(IAPCatalog.subscriptions(interval: "monthly").count, 3)
        XCTAssertEqual(IAPCatalog.subscriptions(interval: "yearly").count, 3)
    }

    func test_subscriptions_areForRequestedInterval() {
        for entry in IAPCatalog.subscriptions(interval: "yearly") {
            if case let .subscription(_, interval) = entry.kind {
                XCTAssertEqual(interval, "yearly")
            } else {
                XCTFail("non-subscription returned")
            }
        }
    }

    func test_entry_lookup() {
        let entry = IAPCatalog.entry(for: "com.gradethread.credits.100")
        XCTAssertEqual(entry?.kind, .consumable(credits: 100))
    }

    // MARK: - Yearly savings (US-1177)

    func test_yearlySavings_pureCalc() {
        // $29/mo → $290/yr: 348 vs 290 = 16.67% → 17%.
        XCTAssertEqual(IAPCatalog.yearlySavingsPercent(monthlyCents: 2900, yearlyCents: 29000), 17)
        // Exact one-month-free (yearly = 11× monthly) ≈ 8%.
        XCTAssertEqual(IAPCatalog.yearlySavingsPercent(monthlyCents: 1000, yearlyCents: 11000), 8)
    }

    func test_yearlySavings_nilWhenNotCheaperOrInvalid() {
        XCTAssertNil(IAPCatalog.yearlySavingsPercent(monthlyCents: 0, yearlyCents: 29000))
        XCTAssertNil(IAPCatalog.yearlySavingsPercent(monthlyCents: 2900, yearlyCents: 0))
        // Yearly priced at exactly 12× monthly → no saving.
        XCTAssertNil(IAPCatalog.yearlySavingsPercent(monthlyCents: 2900, yearlyCents: 34800))
        // Yearly more expensive than annualized monthly → no badge.
        XCTAssertNil(IAPCatalog.yearlySavingsPercent(monthlyCents: 2900, yearlyCents: 40000))
    }

    func test_yearlySavings_perPlan_matchesCatalogTiers() {
        // All three tiers are priced at 10× monthly for the year → ~17% off.
        for plan in ["starter", "pro", "business"] {
            XCTAssertEqual(IAPCatalog.yearlySavingsPercent(plan: plan), 17, "plan \(plan)")
        }
    }

    func test_yearlySavings_onlyBadgesYearlySubscriptionRows() {
        // Yearly subscription → badge.
        XCTAssertEqual(
            IAPCatalog.yearlySavingsPercent(for: IAPCatalog.entry(for: "com.gradethread.sub.pro.yearly")!),
            17)
        // Monthly subscription → no badge.
        XCTAssertNil(
            IAPCatalog.yearlySavingsPercent(for: IAPCatalog.entry(for: "com.gradethread.sub.pro.monthly")!))
        // Consumable → no badge.
        XCTAssertNil(
            IAPCatalog.yearlySavingsPercent(for: IAPCatalog.entry(for: "com.gradethread.credits.50")!))
    }

    func test_maxYearlySavings_isSeventeenPercent() {
        XCTAssertEqual(IAPCatalog.maxYearlySavingsPercent, 17)
    }
}
