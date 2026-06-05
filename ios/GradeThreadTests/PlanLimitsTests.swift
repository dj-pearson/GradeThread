import XCTest
@testable import GradeThread

/// Pure plan-limit math for the Settings "Plan & credits" section.
final class PlanLimitsTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_700_000_000)  // 2023-11-14T22:13:20Z

    private func iso(_ offsetDays: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: now.addingTimeInterval(offsetDays * 86_400))
    }

    func test_knownPlan_returnsCap() {
        let usage = GradePlanLimits.includedUsage(plan: "pro", gradesUsed: 4, resetAt: iso(10), now: now)
        XCTAssertEqual(usage?.cap, 30)
        XCTAssertEqual(usage?.used, 4)
    }

    func test_planIsCaseInsensitive() {
        XCTAssertEqual(GradePlanLimits.includedUsage(plan: "Business", gradesUsed: 0, resetAt: nil, now: now)?.cap, 75)
    }

    func test_unknownPlan_returnsNil() {
        XCTAssertNil(GradePlanLimits.includedUsage(plan: "enterprise", gradesUsed: 0, resetAt: nil, now: now))
        XCTAssertNil(GradePlanLimits.includedUsage(plan: nil, gradesUsed: 0, resetAt: nil, now: now))
    }

    func test_resetInPast_zeroesUsage() {
        let usage = GradePlanLimits.includedUsage(plan: "free", gradesUsed: 3, resetAt: iso(-1), now: now)
        XCTAssertEqual(usage?.used, 0)
        XCTAssertEqual(usage?.cap, 3)
    }

    func test_resetInFuture_keepsUsage() {
        let usage = GradePlanLimits.includedUsage(plan: "free", gradesUsed: 2, resetAt: iso(5), now: now)
        XCTAssertEqual(usage?.used, 2)
    }

    func test_usageCappedAtPlanLimit() {
        let usage = GradePlanLimits.includedUsage(plan: "free", gradesUsed: 99, resetAt: iso(5), now: now)
        XCTAssertEqual(usage?.used, 3)  // clamped to the cap
        XCTAssertEqual(usage?.cap, 3)
    }

    func test_nilResetAt_usesGivenUsage() {
        let usage = GradePlanLimits.includedUsage(plan: "starter", gradesUsed: 6, resetAt: nil, now: now)
        XCTAssertEqual(usage?.used, 6)
        XCTAssertEqual(usage?.cap, 10)
    }
}
