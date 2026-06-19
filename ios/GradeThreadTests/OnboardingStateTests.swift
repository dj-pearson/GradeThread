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

    // US-747: use-case capture + first-action routing.

    func test_selectedUseCase_roundTripsAndClears() {
        let state = OnboardingState(defaults: defaults)
        XCTAssertNil(state.selectedUseCase)
        state.selectedUseCase = .reseller
        XCTAssertEqual(OnboardingState(defaults: defaults).selectedUseCase, .reseller)
        state.selectedUseCase = nil
        XCTAssertNil(OnboardingState(defaults: defaults).selectedUseCase)
    }

    func test_complete_withUseCase_setsFlagUseCaseAndPending() {
        let state = OnboardingState(defaults: defaults)
        state.complete(useCase: .grader)
        let reread = OnboardingState(defaults: defaults)
        XCTAssertTrue(reread.hasCompleted)
        XCTAssertEqual(reread.selectedUseCase, .grader)
        XCTAssertTrue(reread.pendingFirstAction, "a chosen use case queues the one-shot first action")
    }

    func test_complete_skipped_completesButQueuesNothing() {
        let state = OnboardingState(defaults: defaults)
        state.complete(useCase: nil)
        let reread = OnboardingState(defaults: defaults)
        XCTAssertTrue(reread.hasCompleted)
        XCTAssertNil(reread.selectedUseCase)
        XCTAssertFalse(reread.pendingFirstAction, "skipping doesn't drop the user anywhere")
    }

    func test_pendingFirstAction_isOneShot() {
        let state = OnboardingState(defaults: defaults)
        state.pendingFirstAction = true
        XCTAssertTrue(OnboardingState(defaults: defaults).pendingFirstAction)
        state.pendingFirstAction = false
        XCTAssertFalse(OnboardingState(defaults: defaults).pendingFirstAction)
    }

    func test_useCaseFirstAction_routesEachCaseToItsSurface() {
        XCTAssertEqual(OnboardingUseCase.reseller.firstAction.section, .home)
        XCTAssertEqual(OnboardingUseCase.reseller.firstAction.intake, .autoLister)
        XCTAssertEqual(OnboardingUseCase.grader.firstAction.section, .home)
        XCTAssertEqual(OnboardingUseCase.grader.firstAction.intake, .photoFirst)
        XCTAssertEqual(OnboardingUseCase.store.firstAction.section, .marketplaces)
        XCTAssertNil(OnboardingUseCase.store.firstAction.intake)
    }

    func test_useCases_haveDistinctNonEmptyCopy() {
        let titles = OnboardingUseCase.allCases.map(\.title)
        XCTAssertEqual(Set(titles).count, titles.count)
        XCTAssertTrue(OnboardingUseCase.allCases.allSatisfy { !$0.title.isEmpty && !$0.subtitle.isEmpty })
    }
}
