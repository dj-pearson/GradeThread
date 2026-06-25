import XCTest
@testable import GradeThread

/// US-1157: pure per-scene state-restoration decisions for iPad multi-window.
/// The `@SceneStorage` wiring is exercised on a simulator (see
/// `ios/IOS_PRODUCTION_READINESS_REMAINING.md`); this locks the decode/encode
/// contract those bindings depend on.
final class SceneRestorationTests: XCTestCase {

    // MARK: - Section round-trip

    func test_persistableRaw_roundTripsEveryRestingSection() {
        for section in [AppSection.home, .inventory, .sales, .marketplaces, .settings] {
            let raw = SceneRestoration.persistableRaw(for: section)
            XCTAssertNotNil(raw, "\(section) should be persistable")
            XCTAssertEqual(SceneRestoration.restoreSection(from: raw ?? ""), section)
        }
    }

    func test_persistableRaw_dropsTransientAddSection() {
        XCTAssertNil(
            SceneRestoration.persistableRaw(for: .add),
            "The Add pseudo-section is transient and must never be persisted"
        )
    }

    func test_restoreSection_ignoresAddAndUnknown() {
        XCTAssertNil(SceneRestoration.restoreSection(from: AppSection.add.rawValue))
        XCTAssertNil(SceneRestoration.restoreSection(from: ""))
        XCTAssertNil(SceneRestoration.restoreSection(from: "not-a-section"))
    }

    func test_rawValues_areStable() {
        // The raw values are persisted to @SceneStorage, so a rename would
        // silently break restoration for already-installed apps.
        XCTAssertEqual(AppSection.home.rawValue, "home")
        XCTAssertEqual(AppSection.inventory.rawValue, "inventory")
        XCTAssertEqual(AppSection.sales.rawValue, "sales")
        XCTAssertEqual(AppSection.marketplaces.rawValue, "marketplaces")
        XCTAssertEqual(AppSection.settings.rawValue, "settings")
    }

    // MARK: - Focused item id

    func test_restorableItemId_returnsTrimmedNonEmpty() {
        XCTAssertEqual(SceneRestoration.restorableItemId(from: "item-123"), "item-123")
        XCTAssertEqual(SceneRestoration.restorableItemId(from: "  item-123  "), "item-123")
    }

    func test_restorableItemId_isNilForBlank() {
        XCTAssertNil(SceneRestoration.restorableItemId(from: ""))
        XCTAssertNil(SceneRestoration.restorableItemId(from: "   "))
    }
}
