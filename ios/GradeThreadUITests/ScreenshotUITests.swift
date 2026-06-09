import UIKit
import XCTest

/// Drives App Store screenshot capture for `fastlane snapshot` (US-197).
/// Run via `cd ios && bundle exec fastlane screenshots`, or in CI via the
/// ios-screenshots.yml workflow.
///
/// The app gates everything behind sign-in, so the in-app surfaces are
/// captured by signing in with the seeded demo/review account against the
/// real backend. Credentials arrive via the test runner's environment —
/// export `TEST_RUNNER_UITEST_EMAIL` / `TEST_RUNNER_UITEST_PASSWORD` before
/// invoking xcodebuild (the TEST_RUNNER_ prefix is stripped and forwarded
/// to this process). Without credentials the test still passes and captures
/// the welcome/login surface only, so the pipeline never hard-fails on a
/// missing secret.
///
/// The build must also carry a REAL anon key (the Debug.xcconfig placeholder
/// can't talk to api.gradethread.com) — the screenshots lane injects
/// SUPABASE_ANON_KEY via xcargs when the env var is set.
final class ScreenshotUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testCaptureScreenshots() throws {
        let app = XCUIApplication()
        setupSnapshot(app)
        // Suppress the first-run onboarding carousel: `-key value` launch
        // arguments land in UserDefaults' argument domain, which overlays
        // the .standard store OnboardingState reads.
        app.launchArguments += ["-com.gradethread.app.onboarding.completed.v1", "YES"]
        app.launch()

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))

        // iPad renders the sidebar/three-column workspace in landscape —
        // also the orientation Apple's 13" screenshot slot accepts natively.
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        if isPad {
            XCUIDevice.shared.orientation = .landscapeLeft
            // Give the split view a beat to settle into the new size class.
            _ = app.wait(for: .runningForeground, timeout: 2)
        }

        let env = ProcessInfo.processInfo.environment
        let email = env["UITEST_EMAIL"] ?? ""
        let password = env["UITEST_PASSWORD"] ?? ""

        guard !email.isEmpty, !password.isEmpty else {
            // No credentials — capture the welcome/login surface so the
            // pipeline is still exercised end to end, then stop.
            snapshot("00_Welcome")
            return
        }

        signInIfNeeded(app, email: email, password: password)

        // Post-auth chrome. Generous timeout: first sign-in does a real
        // network round-trip + initial sync. The "Home" text exists in both
        // layouts (tab bar item on iPhone, nav title/sidebar row on iPad).
        XCTAssertTrue(
            app.staticTexts["Home"].firstMatch.waitForExistence(timeout: 45)
                || app.tabBars.buttons["Home"].waitForExistence(timeout: 5),
            "Signed-in UI never appeared — check demo credentials, anon key, and network."
        )

        // 01 — Home dashboard (sales snapshot + aging alerts).
        tapDestination(app, "Home")
        snapshot("01_Home")

        // 02 — Inventory grid.
        tapDestination(app, "Inventory")
        snapshot("02_Inventory")

        // 03 — Item canvas (first item), when the demo account has content.
        let firstCell = app.collectionViews.cells.firstMatch.exists
            ? app.collectionViews.cells.firstMatch
            : app.cells.firstMatch
        if firstCell.waitForExistence(timeout: 8) {
            firstCell.tap()
            // Let photos/grade panels load before snapping.
            _ = app.navigationBars.firstMatch.waitForExistence(timeout: 5)
            snapshot("03_ItemCanvas")
            let back = app.navigationBars.buttons.firstMatch
            if back.exists { back.tap() }
        }

        // 04 — Money (sales + payouts). First visit triggers the push
        // permission prompt; clear it before snapping.
        tapDestination(app, "Money")
        dismissSystemAlertIfPresent()
        snapshot("04_Money")

        // 05 — Marketplaces (eBay connection).
        tapDestination(app, "Marketplaces")
        snapshot("05_Marketplaces")
    }

    // MARK: - Helpers

    /// Types the demo credentials into the login form when it's showing.
    /// Skipped entirely when a cached session restores straight to the app.
    @MainActor
    private func signInIfNeeded(_ app: XCUIApplication, email: String, password: String) {
        let emailField = app.textFields["Email"]
        guard emailField.waitForExistence(timeout: 8) else { return }

        snapshot("00_Welcome")

        emailField.tap()
        emailField.typeText(email)

        let passwordField = app.secureTextFields["Password"]
        passwordField.tap()
        passwordField.typeText(password)

        // Dismiss the keyboard if it covers the button, then submit.
        let signIn = app.buttons["Sign in"].firstMatch
        if !signIn.isHittable {
            app.swipeUp(velocity: .slow)
        }
        signIn.tap()
    }

    /// Navigates to a top-level destination across both layouts: the iPhone
    /// tab bar and the iPad NavigationSplitView sidebar. The sidebar can be
    /// COLLAPSED (the first CI run failed exactly here: only the "Home" nav
    /// title matched, no sidebar rows existed) — so when the row isn't on
    /// screen, reveal the sidebar via its toggle and retry.
    @MainActor
    private func tapDestination(_ app: XCUIApplication, _ label: String) {
        let tab = app.tabBars.buttons[label]
        if tab.waitForExistence(timeout: 2) {
            tab.tap()
            return
        }

        for attempt in 0..<2 {
            // Sidebar rows surface as buttons, cells, or plain static text
            // depending on the SwiftUI/OS version — probe in that order.
            let candidates = [
                app.buttons[label].firstMatch,
                app.cells.containing(.staticText, identifier: label).firstMatch,
                app.staticTexts[label].firstMatch,
            ]
            for element in candidates where element.waitForExistence(timeout: 2) {
                if element.isHittable {
                    element.tap()
                    return
                }
            }
            if attempt == 0 { revealSidebar(app) }
        }
        XCTFail("Could not navigate to \(label) — no tab bar item or sidebar row found.")
    }

    /// Opens the NavigationSplitView sidebar when it's collapsed (iPad).
    @MainActor
    private func revealSidebar(_ app: XCUIApplication) {
        let toggle = app.buttons["ToggleSidebar"].firstMatch
        if toggle.exists {
            toggle.tap()
        } else {
            // SwiftUI's toggle is the leading nav-bar button when unlabeled.
            let leading = app.navigationBars.firstMatch.buttons.firstMatch
            if leading.exists { leading.tap() }
        }
        // Give the sidebar animation a beat before re-probing.
        _ = app.wait(for: .runningForeground, timeout: 1)
    }

    /// Taps through a system permission alert (push notifications) if one
    /// is on screen. Springboard-scoped so it works regardless of which
    /// interaction triggered the prompt.
    @MainActor
    private func dismissSystemAlertIfPresent() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: 4) else { return }
        for label in ["Allow", "Don\u{2019}t Allow", "OK"] {
            let button = alert.buttons[label]
            if button.exists {
                button.tap()
                return
            }
        }
    }
}
