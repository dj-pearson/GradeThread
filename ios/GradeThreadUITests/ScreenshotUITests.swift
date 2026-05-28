import XCTest

/// Drives App Store screenshot capture for `fastlane snapshot` (US-197).
/// Run via `cd ios && bundle exec fastlane screenshots`, which launches
/// this across the device sizes in fastlane/Snapfile.
///
/// The app gates everything behind sign-in. Capturing the in-app
/// surfaces (inventory, item canvas, sales) needs a seeded UI-test
/// session — wired behind the `-uiTestScreenshots` launch argument the
/// Snapfile passes, which the app can branch on to load a demo dataset
/// without hitting the network. Until that demo-seed path lands in the
/// app, this test reliably captures the launch/login surface so the
/// snapshot pipeline is exercised end-to-end in CI and the screenshot
/// folders are populated.
final class ScreenshotUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testCaptureScreenshots() throws {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments += ["-uiTestScreenshots", "YES"]
        app.launch()

        // 01 — Launch / sign-in surface. Always reachable.
        // Wait for the first window to settle so we don't snap a blank
        // frame on slower simulators.
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        snapshot("01_Welcome")

        // 02..n — In-app surfaces. Guarded so the test passes whether or
        // not the demo-seed path is present; when it is, these capture
        // the inventory grid, item canvas, and sales tabs. We probe for
        // the tab bar (only present post-auth) and walk it if found.
        let inventoryTab = app.tabBars.buttons["Inventory"]
        if inventoryTab.waitForExistence(timeout: 5) {
            inventoryTab.tap()
            snapshot("02_Inventory")

            // Open the first item's canvas if the grid has content.
            let firstCell = app.collectionViews.cells.firstMatch
            if firstCell.waitForExistence(timeout: 3) {
                firstCell.tap()
                snapshot("03_ItemCanvas")
                if app.navigationBars.buttons.firstMatch.exists {
                    app.navigationBars.buttons.firstMatch.tap()
                }
            }

            let salesTab = app.tabBars.buttons["Sales"]
            if salesTab.exists {
                salesTab.tap()
                snapshot("04_Sales")
            }

            let marketplacesTab = app.tabBars.buttons["Marketplaces"]
            if marketplacesTab.exists {
                marketplacesTab.tap()
                snapshot("05_Marketplaces")
            }
        }
    }
}
