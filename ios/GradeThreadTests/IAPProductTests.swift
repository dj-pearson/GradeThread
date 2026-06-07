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
}
