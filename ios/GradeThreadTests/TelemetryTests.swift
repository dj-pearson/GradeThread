import XCTest
@testable import GradeThread

@MainActor
final class TelemetryTests: XCTestCase {

    private let toggleKey = "com.gradethread.app.analytics.enabled"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: toggleKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: toggleKey)
        super.tearDown()
    }

    // MARK: - Opt-in toggle

    func test_isAnalyticsEnabled_defaultsToTrue() {
        // No value in UserDefaults → default ON per the AC.
        XCTAssertTrue(Telemetry.isAnalyticsEnabled)
    }

    func test_isAnalyticsEnabled_persistsToUserDefaults() {
        Telemetry.isAnalyticsEnabled = false
        XCTAssertFalse(Telemetry.isAnalyticsEnabled)
        XCTAssertEqual(UserDefaults.standard.bool(forKey: toggleKey), false)
    }

    func test_isAnalyticsEnabled_roundTripsAcrossReads() {
        Telemetry.isAnalyticsEnabled = false
        XCTAssertFalse(Telemetry.isAnalyticsEnabled)
        Telemetry.isAnalyticsEnabled = true
        XCTAssertTrue(Telemetry.isAnalyticsEnabled)
    }

    // MARK: - TelemetryEvent string constants

    func test_eventConstants_pinnedToACStrings() {
        // The PostHog dashboard groups by these strings — renaming any
        // of them silently splits historical data into a new event.
        XCTAssertEqual(TelemetryEvent.appOpen, "app_open")
        XCTAssertEqual(TelemetryEvent.intakeCompleted, "intake_completed")
        XCTAssertEqual(TelemetryEvent.aiExtractUsed, "ai_extract_used")
        XCTAssertEqual(TelemetryEvent.ebaySynced, "ebay_synced")
        XCTAssertEqual(TelemetryEvent.listingPublished, "listing_published")
        XCTAssertEqual(TelemetryEvent.saleRecorded, "sale_recorded")
    }

    // MARK: - Event + breadcrumb idempotence

    func test_event_doesNotCrash_whenAnalyticsDisabled() {
        // Calls should no-op silently regardless of SDK config state.
        Telemetry.isAnalyticsEnabled = false
        Telemetry.event(TelemetryEvent.appOpen, props: ["foo": "bar"])
        // If we got here without a crash, the no-op path works.
        XCTAssertFalse(Telemetry.isAnalyticsEnabled)
    }

    func test_breadcrumb_doesNotCrash_whenSentryNotConfigured() {
        // AppConfig.sentryDSN is empty in test builds — the breadcrumb
        // path must short-circuit cleanly.
        Telemetry.breadcrumb("test breadcrumb", category: "test")
        // No assertion needed — the test passes by not crashing.
    }

    func test_clearUser_doesNotCrash_evenWithoutPriorSetUser() {
        // Sign-out path might fire before any setUser, e.g. session
        // expired at app launch.
        Telemetry.clearUser()
    }
}
