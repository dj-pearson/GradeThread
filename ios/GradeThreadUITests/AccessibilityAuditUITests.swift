import XCTest

/// Automated accessibility audit (US accessibility sweep). Drives Apple's
/// `XCUIApplication.performAccessibilityAudit()` — the same engine Xcode's
/// Accessibility Inspector uses — across the app's main reachable screens. It
/// catches regressions in contrast, hit-region size, element labelling, clipped
/// text, and Dynamic Type support that a human reviewer would otherwise have to
/// spot by hand.
///
/// Hermetic, like ``CriticalFlowUITests``: launches with `-uitest` and the
/// onboarding flag so no live network / App Store Connect round-trip happens. It
/// audits whatever first screen renders (sign-in when signed out, the shell when
/// a session is restored) and then walks each bottom-tab destination when signed
/// in — so coverage scales with whatever the simulator session exposes without
/// hard-failing on a missing credential.
///
/// `performAccessibilityAudit()` requires iOS 17+; on older runtimes the tests
/// skip cleanly. Audit findings are reported by XCTest as individual issues; we
/// additionally fail with the screen name so a failure is traceable to where it
/// was found.
final class AccessibilityAuditUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    /// Audits the first screen the app boots to. Always runs — it needs no
    /// signed-in session — so it's the baseline guard for the sign-in surface
    /// (or the shell, if a session was restored on the simulator).
    @MainActor
    func testLaunchScreenPassesAccessibilityAudit() throws {
        try XCTSkipUnless(auditAvailable, "performAccessibilityAudit() requires iOS 17+.")
        let app = launch()
        XCTAssertEqual(app.state, .runningForeground, "App should launch cleanly for the audit.")
        // Give the SwiftUI tree a moment to mount before snapshotting it.
        _ = app.buttons.firstMatch.waitForExistence(timeout: 20)
        audit(app, screen: "Launch / first screen")
    }

    /// Walks each bottom-tab destination and audits it. Only meaningful when a
    /// session is restored (the tab bar lives behind auth); otherwise it asserts
    /// nothing and returns, matching the ``SmokeUITests`` / ``CriticalFlowUITests``
    /// contract of never hard-failing on a missing credential.
    @MainActor
    func testMainTabsPassAccessibilityAudit() throws {
        try XCTSkipUnless(auditAvailable, "performAccessibilityAudit() requires iOS 17+.")
        let app = launch()

        let tabBar = app.tabBars.firstMatch
        guard tabBar.waitForExistence(timeout: 20) else {
            // Signed out: no shell to walk. The launch-screen test covers the
            // sign-in surface, so there's nothing more to audit here.
            return
        }

        // Snapshot the tab labels up front (the live query mutates as we navigate).
        let tabButtons = tabBar.buttons.allElementsBoundByIndex
        let tabLabels = tabButtons.map(\.label)

        for label in tabLabels where !label.isEmpty {
            let tab = tabBar.buttons[label]
            guard tab.exists, tab.isHittable else { continue }
            tab.tap()
            // Let the destination settle before auditing it.
            _ = app.staticTexts.firstMatch.waitForExistence(timeout: 5)
            audit(app, screen: "Tab: \(label)")
        }
    }

    // MARK: - Helpers

    /// `true` when the OS provides `performAccessibilityAudit()` (iOS 17+).
    private var auditAvailable: Bool {
        if #available(iOS 17.0, *) { return true }
        return false
    }

    /// Runs the full accessibility audit, attributing any failure to `screen`.
    /// Individual findings are recorded by XCTest as their own issues; the
    /// surrounding `catch` surfaces a setup/runtime failure with context.
    @MainActor
    private func audit(_ app: XCUIApplication, screen: String) {
        guard #available(iOS 17.0, *) else { return }
        do {
            try app.performAccessibilityAudit()
        } catch {
            XCTFail("Accessibility audit failed on \(screen): \(error)")
        }
    }

    /// Launches the app hermetically with onboarding suppressed, mirroring
    /// ``CriticalFlowUITests`` so the under-test surfaces are reachable without
    /// walking the welcome flow.
    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-uitest"]
        app.launchArguments += ["-com.gradethread.app.onboarding.completed.v1", "YES"]
        app.launch()
        return app
    }
}
