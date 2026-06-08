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

    // MARK: - TelemetryScrubber (US-662)

    func test_scrubber_redactsEmail() {
        let out = TelemetryScrubber.redact("login failed for seller@example.com retrying")
        XCTAssertFalse(out.contains("seller@example.com"))
        XCTAssertTrue(out.contains("[redacted-email]"))
    }

    func test_scrubber_redactsBearerToken() {
        let out = TelemetryScrubber.redact("Authorization: Bearer eyJhbGciOiJIUzI1Ni012345.abc-DEF")
        XCTAssertFalse(out.contains("eyJhbGci"))
        XCTAssertTrue(out.contains("Bearer [redacted]"))
    }

    func test_scrubber_redactsApiKeyAndTokens() {
        let out = TelemetryScrubber.redact("apikey=supersecret123 access_token: tok_abc-123")
        XCTAssertFalse(out.contains("supersecret123"))
        XCTAssertFalse(out.contains("tok_abc-123"))
        XCTAssertTrue(out.contains("[redacted]"))
    }

    func test_scrubber_redactsStorageURL() {
        let out = TelemetryScrubber.redact("fetch https://api.gradethread.com/storage/v1/object/sign/x?token=abc failed")
        XCTAssertFalse(out.contains("token=abc"))
        XCTAssertTrue(out.contains("[redacted-storage-url]"))
    }

    func test_scrubber_leavesCleanTextUntouched() {
        let input = "sync merged 42 rows in 1.2s"
        XCTAssertEqual(TelemetryScrubber.redact(input), input)
    }

    // MARK: - Breadcrumb data scrubbing (US-695)

    func test_scrubbedBreadcrumbData_redactsUrlValue() {
        // Swizzled HTTP breadcrumbs store the request URL in data["url"];
        // the message-only scrub never touched it.
        let scrubbed = Telemetry.scrubbedBreadcrumbData([
            "url": "https://api.gradethread.com/storage/v1/object/sign/x?token=abc",
            "method": "GET",
            "status_code": 200,
        ])
        XCTAssertEqual(scrubbed?["url"] as? String, "[redacted-storage-url]")
        // Non-sensitive values pass through untouched (string + non-string).
        XCTAssertEqual(scrubbed?["method"] as? String, "GET")
        XCTAssertEqual(scrubbed?["status_code"] as? Int, 200)
    }

    func test_scrubbedBreadcrumbData_redactsBearerAndEmail() {
        let scrubbed = Telemetry.scrubbedBreadcrumbData([
            "auth": "Bearer eyJabc.def",
            "user": "seller@example.com",
        ])
        XCTAssertEqual(scrubbed?["auth"] as? String, "Bearer [redacted]")
        XCTAssertFalse((scrubbed?["user"] as? String ?? "").contains("seller@example.com"))
    }

    func test_scrubbedBreadcrumbData_handlesNil() {
        XCTAssertNil(Telemetry.scrubbedBreadcrumbData(nil))
    }
}
