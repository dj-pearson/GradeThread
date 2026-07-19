import XCTest

/// Launch smoke test: the app boots to its first screen without crashing.
///
/// Backend-independent on purpose — it asserts only that the UI mounts (the
/// welcome/sign-in surface, or the dashboard if a session is restored), so it
/// runs in CI without seeded credentials and never hard-fails on a missing
/// secret. This is the foundation the audit (`vault/90-archive/ios-parity-audit.md`) called for;
/// auth'd seam-flow tests (edit field → eBay specifics, measurement edit,
/// garment fields → grading) are the next step and need the
/// `TEST_RUNNER_UITEST_*` credentials the screenshots lane already uses.
///
/// Lives in the `GradeThreadUITests` target but is run on its own via
/// `-only-testing:GradeThreadUITests/SmokeUITests` (see `ios-smoke.yml`), so it
/// never triggers the fastlane snapshot capture in `ScreenshotUITests`.
final class SmokeUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testAppLaunchesToFirstScreen() throws {
        let app = XCUIApplication()
        app.launch()

        XCTAssertEqual(
            app.state, .runningForeground,
            "the app should be in the foreground after launch (no launch crash)"
        )

        // The first screen renders interactive/text content within a reasonable
        // boot window — either the welcome/sign-in surface or, if a session was
        // restored, the dashboard. Either proves the SwiftUI tree mounted.
        let contentAppeared =
            app.buttons.firstMatch.waitForExistence(timeout: 20)
            || app.staticTexts.firstMatch.waitForExistence(timeout: 1)
        XCTAssertTrue(
            contentAppeared,
            "expected the first screen to render content after launch"
        )
    }
}
