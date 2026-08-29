import XCTest
import Sentry
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
        // US-2914: the regime is process-wide state now. Leaving one test's
        // value set would make the next test's answer depend on ordering, which
        // is the failure that is hardest to read when it finally shows up.
        Telemetry.setResolvedRegimeForTests(nil)
        super.tearDown()
    }

    // MARK: - Opt-in toggle

    func test_isAnalyticsEnabled_noLongerDefaultsToTrue() {
        // US-2914 INVERTED THIS, and the old assertion is what iOS CI caught:
        // this used to read "No value in UserDefaults → default ON per the AC"
        // and XCTAssertTrue. That AC is gone. Analytics is now opt-in
        // everywhere except the US, and opt-in whenever the country is unknown
        // - which is what an unresolved regime is during a test.
        //
        // The same shape as US-2840's fee-rate test, which still asserted
        // 0.1325 after the constant moved to 0.136: a pin is only a pin if it
        // moves with the number. Rewritten rather than deleted, because "no
        // stored choice does NOT mean on" is exactly the property worth
        // holding, just with the opposite sign.
        Telemetry.setResolvedRegimeForTests(nil)
        XCTAssertFalse(Telemetry.isAnalyticsEnabled)
        XCTAssertNil(Telemetry.explicitAnalyticsChoice)
    }

    func test_isAnalyticsEnabled_followsTheRegimeWhenNobodyHasChosen() {
        // The tri-state in one place: absent choice means the regime decides.
        Telemetry.setResolvedRegimeForTests(.optOut)
        XCTAssertTrue(Telemetry.isAnalyticsEnabled)
        Telemetry.setResolvedRegimeForTests(.optIn)
        XCTAssertFalse(Telemetry.isAnalyticsEnabled)
        Telemetry.setResolvedRegimeForTests(nil)
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

    // MARK: - Sentry user context carries no PII (US-1014)

    func test_makeSentryUser_setsOnlyUserId_neverEmail() {
        let user = Telemetry.makeSentryUser(id: "auth-uid-123")
        XCTAssertEqual(user.userId, "auth-uid-123")
        // The whole point of the story: email (and other PII) is never
        // stamped onto the Sentry user context.
        XCTAssertNil(user.email)
        XCTAssertNil(user.username)
        XCTAssertNil(user.ipAddress)
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

    // US-1178: raw UUIDs (user/workspace/item ids) are redacted from breadcrumbs.
    func test_scrubber_redactsUUID() {
        let out = TelemetryScrubber.redact("load failed for item 3F2504E0-4F89-41D3-9A0C-0305E82C3301")
        XCTAssertFalse(out.contains("3F2504E0"))
        XCTAssertTrue(out.contains("[redacted-uuid]"))
    }

    // MARK: - Event property scrubbing (US-991)

    func test_redactProperties_redactsStringValues() {
        let out = Telemetry.redactProperties([
            "detail": "login failed for seller@example.com",
            "auth": "Bearer eyJhbGci.abc-DEF",
            "url": "https://api.gradethread.com/storage/v1/object/sign/x?token=abc",
        ])
        XCTAssertEqual(out["detail"] as? String, "login failed for [redacted-email]")
        XCTAssertEqual(out["auth"] as? String, "Bearer [redacted]")
        XCTAssertEqual(out["url"] as? String, "[redacted-storage-url]")
    }

    func test_redactProperties_leavesNonStringValuesUntouched() {
        let out = Telemetry.redactProperties([
            "count": 42,
            "online": true,
            "tier": "express",
        ])
        XCTAssertEqual(out["count"] as? Int, 42)
        XCTAssertEqual(out["online"] as? Bool, true)
        // A clean string is passed through verbatim.
        XCTAssertEqual(out["tier"] as? String, "express")
    }

    func test_redactProperties_recursesIntoNestedCollections() {
        let out = Telemetry.redactProperties([
            "emails": ["a@example.com", "clean"],
            "nested": ["token": "apikey=supersecret123"],
        ])
        let emails = out["emails"] as? [String]
        XCTAssertEqual(emails?.first, "[redacted-email]")
        XCTAssertEqual(emails?.last, "clean")
        let nested = out["nested"] as? [String: Any]
        XCTAssertFalse((nested?["token"] as? String ?? "").contains("supersecret123"))
    }

    // MARK: - Breadcrumb data scrubbing (US-695)

    func test_scrubBreadcrumb_redactsUrlInStructuredData() {
        // Swizzled HTTP breadcrumbs store the request URL in crumb.data["url"];
        // the message-only scrub never touched it.
        let crumb = Breadcrumb()
        crumb.message = "request to seller@example.com"
        crumb.data = [
            "url": "https://api.gradethread.com/storage/v1/object/sign/x?token=abc",
            "method": "GET",
            "status_code": 200,
        ]
        Telemetry.scrubBreadcrumb(crumb)

        let url = crumb.data?["url"] as? String
        XCTAssertEqual(url, "[redacted-storage-url]")
        // Non-sensitive values pass through untouched (string + non-string).
        XCTAssertEqual(crumb.data?["method"] as? String, "GET")
        XCTAssertEqual(crumb.data?["status_code"] as? Int, 200)
        // Message is still scrubbed too.
        XCTAssertFalse(crumb.message?.contains("seller@example.com") ?? true)
    }

    func test_scrubBreadcrumb_handlesNilData() {
        let crumb = Breadcrumb()
        crumb.message = "Bearer eyJabc.def"
        Telemetry.scrubBreadcrumb(crumb)
        XCTAssertTrue(crumb.message?.contains("Bearer [redacted]") ?? false)
    }

    // MARK: - Signed-storage URL + header redaction (US-990)

    func test_scrubBreadcrumb_redactsSignedStorageUrlInHttpUrl() {
        // Sentry's swizzled HTTP breadcrumbs store the request URL under
        // `http.url` (not just `url`); a signed Storage upload URL carries the
        // path + a `?token=` query that must never ship.
        let crumb = Breadcrumb()
        crumb.data = [
            "http.url": "https://api.gradethread.com/storage/v1/object/item-photos/u/i/front_1.jpg?token=eyJsigned.abc-DEF",
            "http.method": "POST",
        ]
        Telemetry.scrubBreadcrumb(crumb)

        let url = crumb.data?["http.url"] as? String
        XCTAssertEqual(url, "[redacted-storage-url]")
        XCTAssertFalse(url?.contains("token=") ?? true)
        XCTAssertEqual(crumb.data?["http.method"] as? String, "POST")
    }

    func test_scrubBreadcrumb_neverContainsBearerToken() {
        // A bearer token can land in the message, a flat data string, OR a
        // nested request-header dict — none may survive the scrub.
        let crumb = Breadcrumb()
        crumb.message = "Authorization: Bearer eyJhbGci.message-tok_ABC"
        crumb.data = [
            "http.url": "https://api.gradethread.com/x?Authorization=Bearer%20unused",
            "auth": "Bearer eyJhbGci.flat-tok_DEF",
            "headers": ["Authorization": "Bearer eyJhbGci.header-tok_GHI"],
        ]
        Telemetry.scrubBreadcrumb(crumb)

        // Flatten everything the crumb still carries into one string and assert
        // no raw token fragment remains anywhere.
        func collect(_ value: Any) -> String {
            switch value {
            case let s as String: return s
            case let a as [Any]: return a.map(collect).joined(separator: " ")
            case let d as [String: Any]: return d.values.map(collect).joined(separator: " ")
            default: return ""
            }
        }
        let haystack = (crumb.message ?? "") + " " + collect(crumb.data ?? [:])
        XCTAssertFalse(haystack.contains("eyJhbGci"))
        XCTAssertFalse(haystack.contains("tok_ABC"))
        XCTAssertFalse(haystack.contains("tok_DEF"))
        XCTAssertFalse(haystack.contains("tok_GHI"))
    }

    func test_scrubBreadcrumb_redactsApiKeyHeaderValue() {
        // A swizzled breadcrumb can split request headers into a nested dict
        // where the `apikey` value is a BARE token (no `apikey=` prefix for the
        // string rule to match) — it must still be redacted by header name.
        let crumb = Breadcrumb()
        crumb.data = [
            "headers": [
                "apikey": "sb_secret_anon_key_12345",
                "Content-Type": "image/jpeg",
            ],
        ]
        Telemetry.scrubBreadcrumb(crumb)

        let headers = crumb.data?["headers"] as? [String: Any]
        XCTAssertEqual(headers?["apikey"] as? String, "[redacted]")
        XCTAssertFalse((headers?["apikey"] as? String ?? "").contains("sb_secret_anon_key_12345"))
        // A non-sensitive header passes through untouched.
        XCTAssertEqual(headers?["Content-Type"] as? String, "image/jpeg")
    }

    func test_redactProperties_redactsApiKeyHeaderValueByName() {
        // Event props carrying a header dict get the same key-aware treatment.
        let out = Telemetry.redactProperties([
            "headers": ["apikey": "sb_secret_anon_key_12345"],
        ])
        let headers = out["headers"] as? [String: Any]
        XCTAssertEqual(headers?["apikey"] as? String, "[redacted]")
    }
}
