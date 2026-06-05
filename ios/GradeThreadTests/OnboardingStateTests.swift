import XCTest
@testable import GradeThread

/// The persisted first-run flag + page model. Uses an isolated UserDefaults
/// suite so it never touches the real app domain.
final class OnboardingStateTests: XCTestCase {

    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "test.onboarding.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    func test_defaultsToNotCompleted() {
        XCTAssertFalse(OnboardingState(defaults: defaults).hasCompleted)
    }

    func test_settingCompleted_persistsAcrossInstances() {
        let state = OnboardingState(defaults: defaults)  // nonmutating set
        state.hasCompleted = true
        XCTAssertTrue(OnboardingState(defaults: defaults).hasCompleted)
    }

    func test_pages_areNonEmptyWithUniqueIds() {
        let ids = OnboardingPage.pages.map(\.id)
        XCTAssertFalse(OnboardingPage.pages.isEmpty)
        XCTAssertEqual(Set(ids).count, ids.count, "Onboarding page ids must be unique")
    }
}
