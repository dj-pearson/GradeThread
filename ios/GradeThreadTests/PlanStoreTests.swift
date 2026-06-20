import XCTest
@testable import GradeThread

/// `PlanStore.PlanInfo` billing-source branching that decides whether Settings
/// manages the subscription natively (App Store) or routes to web billing.
final class PlanStoreTests: XCTestCase {

    private func info(source: String?, status: String?) -> PlanStore.PlanInfo {
        PlanStore.PlanInfo(
            flipdesk_plan: "pro",
            grade_credit_balance: 0,
            grades_used_this_month: 0,
            grade_reset_at: nil,
            billing_source: source,
            subscription_status: status)
    }

    func test_billedOnAppStore_trueOnlyForAppstoreAndEntitlingStatus() {
        XCTAssertTrue(info(source: "appstore", status: "active").billedOnAppStore)
        XCTAssertTrue(info(source: "appstore", status: "trialing").billedOnAppStore)
        XCTAssertTrue(info(source: "appstore", status: "past_due").billedOnAppStore)
    }

    func test_billedOnAppStore_falseForLapsedAppstoreSub() {
        XCTAssertFalse(info(source: "appstore", status: "canceled").billedOnAppStore)
        XCTAssertFalse(info(source: "appstore", status: nil).billedOnAppStore)
    }

    func test_billedOnAppStore_falseForStripeOrFree() {
        // Stripe-billed users keep the web-billing route.
        XCTAssertFalse(info(source: "stripe", status: "active").billedOnAppStore)
        // Free users have no billing source.
        XCTAssertFalse(info(source: nil, status: nil).billedOnAppStore)
    }
}
