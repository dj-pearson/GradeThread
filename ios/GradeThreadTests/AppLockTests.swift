import XCTest
@testable import GradeThread

/// US-696 / US-1016 — exercises the app-lock gating state machine with injected
/// evaluator closures (no real LAContext).
@MainActor
final class AppLockTests: XCTestCase {

    private let enabledKey = "com.gradethread.app.applock.enabled"
    private let biometricsOnlyKey = "com.gradethread.app.applock.biometricsOnly"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: enabledKey)
        UserDefaults.standard.removeObject(forKey: biometricsOnlyKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: enabledKey)
        UserDefaults.standard.removeObject(forKey: biometricsOnlyKey)
        super.tearDown()
    }

    func test_disabledByDefault_startsUnlocked() {
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in true })
        XCTAssertFalse(lock.isEnabled)
        XCTAssertEqual(lock.state, .unlocked)
    }

    func test_enabledColdLaunch_startsLocked() {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in true })
        XCTAssertEqual(lock.state, .locked)
    }

    func test_authenticate_successUnlocks() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in true })
        XCTAssertEqual(lock.state, .locked)
        await lock.authenticate()
        XCTAssertEqual(lock.state, .unlocked)
    }

    func test_authenticate_failureStaysLocked() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in false })
        await lock.authenticate()
        XCTAssertEqual(lock.state, .locked)
    }

    func test_authenticate_thrownErrorStaysLocked() async {
        struct Boom: Error {}
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in throw Boom() })
        await lock.authenticate()
        XCTAssertEqual(lock.state, .locked)
    }

    /// Anti-lockout: a device with NO owner-authentication method configured at
    /// all must never trap the user out — the lock auto-unlocks, and that branch
    /// is telemetered.
    func test_authenticate_whenNoAuthConfigured_doesNotStrandUser_andTelemeters() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        var reported: AppLock.AuthMode?
        let lock = AppLock(
            canEvaluate: { _ in false },
            evaluate: { _, _ in false },
            onAntiLockoutUnlock: { reported = $0 }
        )
        await lock.authenticate()
        XCTAssertEqual(lock.state, .unlocked)
        XCTAssertEqual(reported, .biometricsOrPasscode)
    }

    func test_lockIfEnabled_relocksOnBackground() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in true })
        await lock.authenticate()
        XCTAssertEqual(lock.state, .unlocked)
        lock.lockIfEnabled()
        XCTAssertEqual(lock.state, .locked)
    }

    func test_disabling_unlocksImmediately() {
        UserDefaults.standard.set(true, forKey: enabledKey)
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in true })
        XCTAssertEqual(lock.state, .locked)
        lock.isEnabled = false
        XCTAssertEqual(lock.state, .unlocked)
    }

    func test_lockIfEnabled_noopWhenDisabled() {
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in true })
        lock.lockIfEnabled()
        XCTAssertEqual(lock.state, .unlocked)
    }

    // MARK: - US-1016 biometrics-only mode

    func test_defaultMode_isBiometricsOrPasscode() {
        let lock = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in true })
        XCTAssertFalse(lock.biometricsOnly)
        XCTAssertEqual(lock.mode, .biometricsOrPasscode)
    }

    func test_biometricsOnly_evaluatesBiometricsPolicy() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        UserDefaults.standard.set(true, forKey: biometricsOnlyKey)
        var evaluatedMode: AppLock.AuthMode?
        let lock = AppLock(
            canEvaluate: { _ in true },
            evaluate: { mode, _ in evaluatedMode = mode; return true }
        )
        XCTAssertEqual(lock.mode, .biometricsOnly)
        await lock.authenticate()
        XCTAssertEqual(evaluatedMode, .biometricsOnly)
        XCTAssertEqual(lock.state, .unlocked)
    }

    /// Biometrics-only with biometrics unavailable (e.g. locked out / not
    /// enrolled) but a passcode IS set: fall back to the passcode policy rather
    /// than stranding OR silently bypassing the lock.
    func test_biometricsOnly_whenBiometricsUnavailable_fallsBackToPasscode() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        UserDefaults.standard.set(true, forKey: biometricsOnlyKey)
        var evaluatedMode: AppLock.AuthMode?
        let lock = AppLock(
            canEvaluate: { mode in mode == .biometricsOrPasscode },
            evaluate: { mode, _ in evaluatedMode = mode; return true }
        )
        await lock.authenticate()
        XCTAssertEqual(evaluatedMode, .biometricsOrPasscode)
        XCTAssertEqual(lock.state, .unlocked)
    }

    /// Biometrics-only with no auth at all configured: anti-lockout unlock, and
    /// the reported mode reflects the configured (biometrics-only) policy.
    func test_biometricsOnly_whenNoAuthAtAll_unlocksAndTelemeters() async {
        UserDefaults.standard.set(true, forKey: enabledKey)
        UserDefaults.standard.set(true, forKey: biometricsOnlyKey)
        var reported: AppLock.AuthMode?
        let lock = AppLock(
            canEvaluate: { _ in false },
            evaluate: { _, _ in false },
            onAntiLockoutUnlock: { reported = $0 }
        )
        await lock.authenticate()
        XCTAssertEqual(lock.state, .unlocked)
        XCTAssertEqual(reported, .biometricsOnly)
    }

    func test_isAvailable_reflectsPasscodePolicy() {
        let withPasscode = AppLock(
            canEvaluate: { $0 == .biometricsOrPasscode },
            evaluate: { _, _ in true }
        )
        XCTAssertTrue(withPasscode.isAvailable)
        XCTAssertFalse(withPasscode.biometricsAvailable)

        let withBiometrics = AppLock(canEvaluate: { _ in true }, evaluate: { _, _ in true })
        XCTAssertTrue(withBiometrics.isAvailable)
        XCTAssertTrue(withBiometrics.biometricsAvailable)
    }
}
