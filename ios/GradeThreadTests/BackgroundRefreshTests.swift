import XCTest
@testable import GradeThread

@MainActor
final class BackgroundRefreshTests: XCTestCase {

    private let toggleKey = "com.gradethread.app.bgRefresh.enabled"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: toggleKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: toggleKey)
        super.tearDown()
    }

    // MARK: - isEnabled (UserDefaults round-trip)

    func test_isEnabled_defaultsToTrue_whenKeyMissing() {
        // No value in UserDefaults — the AC says default ON.
        let service = BackgroundRefreshService()
        XCTAssertTrue(service.isEnabled)
    }

    func test_isEnabled_writesThroughToUserDefaults() {
        var service = BackgroundRefreshService()
        service.isEnabled = false
        XCTAssertFalse(service.isEnabled)
        XCTAssertEqual(UserDefaults.standard.bool(forKey: toggleKey), false)
    }

    func test_isEnabled_secondInstance_sees_persistedValue() {
        // Cross-instance state — important because the Settings toggle
        // and the AppDelegate handler each construct fresh
        // BackgroundRefreshService values and rely on UserDefaults to
        // share state.
        var service = BackgroundRefreshService()
        service.isEnabled = false
        let other = BackgroundRefreshService()
        XCTAssertFalse(other.isEnabled)
    }

    func test_refreshIdentifier_matchesInfoPlist() {
        // BGTaskScheduler will refuse to register/submit an identifier
        // that isn't in BGTaskSchedulerPermittedIdentifiers. This test
        // pins the value so any rename here forces an Info.plist update
        // alongside.
        XCTAssertEqual(
            BackgroundRefreshService.refreshIdentifier,
            "com.gradethread.app.refresh"
        )
    }
}
