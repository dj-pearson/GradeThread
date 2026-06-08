import XCTest
@testable import GradeThread

/// US-696 — exercises the app-lock gating state machine with injected
/// evaluator closures (no real LAContext).
@MainActor
final class AppLockTests: XCTestCase {

    private let enabledKey = "com.gradethread.app.applock.enabled"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: enabledKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: enabledKey)
        super.tearDown()
    }

    func test_disabledByDefault_startsUnlocked() {
        let lock = AppLock(canEvaluate: { true }, evaluate: { _ in true })
        XCTAssertFalse(lock.isEnabled)
        XCTAssertEqual(lock.state, .unlocked)
    }

    func test_enabledColdLaunch_startsLocked() {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { true }, evaluate: { _ in true })
        XCTAssertEqual(lock.state, .locked)
    }

    func test_authenticate_successUnlocks() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { true }, evaluate: { _ in true })
        XCTAssertEqual(lock.state, .locked)
        await lock.authenticate()
        XCTAssertEqual(lock.state, .unlocked)
    }

    func test_authenticate_failureStaysLocked() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { true }, evaluate: { _ in false })
        await lock.authenticate()
        XCTAssertEqual(lock.state, .locked)
    }

    func test_authenticate_thrownErrorStaysLocked() async {
        struct Boom: Error {}
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { true }, evaluate: { _ in throw Boom() })
        await lock.authenticate()
        XCTAssertEqual(lock.state, .locked)
    }

    func test_authenticate_whenNoBiometricsAvailable_doesNotStrandUser() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { false }, evaluate: { _ in false })
        await lock.authenticate()
        XCTAssertEqual(lock.state, .unlocked)
    }

    func test_lockIfEnabled_relocksOnBackground() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { true }, evaluate: { _ in true })
        await lock.authenticate()
        XCTAssertEqual(lock.state, .unlocked)
        lock.lockIfEnabled()
        XCTAssertEqual(lock.state, .locked)
    }

    func test_disabling_unlocksImmediately() {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { true }, evaluate: { _ in true })
        XCTAssertEqual(lock.state, .locked)
        lock.isEnabled = false
        XCTAssertEqual(lock.state, .unlocked)
    }

    func test_lockIfEnabled_noopWhenDisabled() {
        let lock = AppLock(canEvaluate: { true }, evaluate: { _ in true })
        lock.lockIfEnabled()
        XCTAssertEqual(lock.state, .unlocked)
    }
}
