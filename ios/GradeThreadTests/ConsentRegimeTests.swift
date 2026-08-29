import XCTest
@testable import GradeThread

/// US-2914 AC6: mirrors `ConsentRegimeTest.kt` and `consent-regime.test.ts`
/// case for case, so a divergence reads as "the clients disagree" rather than
/// "this client has a bug".
///
/// The two that matter most are named as such in the criterion: a fresh install
/// in the EU does not start analytics, and a fresh install with no network does
/// not either. Both are the fail-safe, and the fail-safe is the whole story -
/// getting it backwards means analytics running by default for exactly the
/// sellers most likely to be covered by GDPR.
final class ConsentRegimeTests: XCTestCase {

    private func geo(_ country: String?, isEU: Bool = false) -> GeoSignal {
        GeoSignal(country: country, regionCode: nil, isEU: isEU)
    }

    // MARK: - The regime

    func test_treatsTheUSAsOptOut_ccpaNotice() {
        XCTAssertEqual(Consent.regime(for: geo("US")), .optOut)
    }

    func test_treatsEUCountriesAsOptIn_gdpr() {
        for c in ["DE", "FR", "IE", "NL", "ES", "IT", "PL"] {
            XCTAssertEqual(Consent.regime(for: geo(c, isEU: true)), .optIn, "\(c)")
        }
    }

    func test_treatsTheUKAndSwitzerlandAsOptIn() {
        XCTAssertEqual(Consent.regime(for: geo("GB")), .optIn)
        XCTAssertEqual(Consent.regime(for: geo("CH")), .optIn)
    }

    func test_treatsRestOfWorldAsOptInByDefault() {
        // Not a GDPR country and not the US. The rule is an allowlist of
        // opt-out jurisdictions, not a blocklist of strict ones, so anywhere
        // unlisted gets the strict answer.
        for c in ["CA", "AU", "JP", "BR", "IN", "NG"] {
            XCTAssertEqual(Consent.regime(for: geo(c)), .optIn, "\(c)")
        }
    }

    func test_failsSafeToOptInWhenGeoIsUnknown() {
        XCTAssertEqual(Consent.regime(for: nil), .optIn)
        XCTAssertEqual(Consent.regime(for: GeoSignal.unknown), .optIn)
        XCTAssertEqual(Consent.regime(for: geo(nil)), .optIn)
    }

    func test_countryMatchingIsCaseInsensitive() {
        XCTAssertEqual(Consent.regime(for: geo("us")), .optOut)
        XCTAssertEqual(Consent.regime(for: geo("Us")), .optOut)
    }

    func test_cloudflarePlaceholderCountriesReadAsUnknown() {
        // Cloudflare answers "XX" for an unresolvable client and "T1" for Tor.
        // Neither is in the opt-out set, so both land on the strict side - the
        // assertion is that they do NOT accidentally match anything.
        XCTAssertEqual(Consent.regime(for: geo("XX")), .optIn)
        XCTAssertEqual(Consent.regime(for: geo("T1")), .optIn)
    }

    func test_aBlankCountryIsUnknownRatherThanAMatch() {
        XCTAssertEqual(Consent.regime(for: geo("")), .optIn)
        XCTAssertEqual(Consent.regime(for: geo("   ")), .optIn)
    }

    // MARK: - The tri-state choice

    func test_anUnaskedSellerFollowsTheRegime() {
        XCTAssertFalse(Consent.analyticsAllowed(regime: .optIn, explicitChoice: nil))
        XCTAssertTrue(Consent.analyticsAllowed(regime: .optOut, explicitChoice: nil))
    }

    func test_anExplicitNoIsHonouredInAnOptOutJurisdiction() {
        // The seller said no. Being in the US does not override that.
        XCTAssertFalse(Consent.analyticsAllowed(regime: .optOut, explicitChoice: false))
    }

    func test_anExplicitYesIsHonouredInAnOptInJurisdiction() {
        XCTAssertTrue(Consent.analyticsAllowed(regime: .optIn, explicitChoice: true))
    }

    // MARK: - The two the criterion names

    func test_aFreshInstallInTheEUDoesNotStartAnalytics() {
        XCTAssertFalse(
            Consent.analyticsAllowed(
                regime: Consent.regime(for: geo("DE", isEU: true)),
                explicitChoice: nil
            )
        )
    }

    func test_aFreshInstallWithNoNetworkDoesNotStartAnalytics() {
        // No network means GeoService returns .unknown, which is opt-in, which
        // with no explicit choice means analytics stays off. A US seller loses
        // their early events; that is the right way round.
        XCTAssertFalse(
            Consent.analyticsAllowed(
                regime: Consent.regime(for: GeoSignal.unknown),
                explicitChoice: nil
            )
        )
    }

    // MARK: - The expression that was removed

    @MainActor
    func test_anAbsentStoredChoiceReadsAsNil_notAsConsent() {
        // `?? true` was the bug. This asserts the READ is tri-state, which is
        // what makes the regime reachable at all - a Bool-typed accessor would
        // have to invent an answer before the regime was consulted.
        let key = "com.gradethread.app.analytics.enabled"
        let saved = UserDefaults.standard.object(forKey: key)
        defer {
            if let saved { UserDefaults.standard.set(saved, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }
        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertNil(Telemetry.explicitAnalyticsChoice)
        UserDefaults.standard.set(false, forKey: key)
        XCTAssertEqual(Telemetry.explicitAnalyticsChoice, false)
        UserDefaults.standard.set(true, forKey: key)
        XCTAssertEqual(Telemetry.explicitAnalyticsChoice, true)
    }

    @MainActor
    func test_anUnresolvedRegimeReadsAsOptIn_notAsOn() {
        // The window before the geo lookup returns. Treating it as permissive
        // is the same defect in a smaller time slice.
        let key = "com.gradethread.app.analytics.enabled"
        let saved = UserDefaults.standard.object(forKey: key)
        defer {
            if let saved { UserDefaults.standard.set(saved, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
            Telemetry.setResolvedRegimeForTests(nil)
        }
        UserDefaults.standard.removeObject(forKey: key)
        Telemetry.setResolvedRegimeForTests(nil)
        XCTAssertFalse(Telemetry.isAnalyticsEnabled)
        Telemetry.setResolvedRegimeForTests(.optOut)
        XCTAssertTrue(Telemetry.isAnalyticsEnabled)
        Telemetry.setResolvedRegimeForTests(.optIn)
        XCTAssertFalse(Telemetry.isAnalyticsEnabled)
    }

    // MARK: - The endpoint

    func test_geoIsFetchedFromThePagesSite_notTheEdgeService() {
        // AC3, and it is worth a test rather than a comment: pointing this at
        // functions.gradethread.com would fail SAFE - every seller opt-in - and
        // therefore look exactly like it was working.
        let url = GeoService.geoURL
        XCTAssertEqual(url?.host, "gradethread.com")
        XCTAssertEqual(url?.path, "/geo.json")
        XCTAssertNotEqual(url?.host, "functions.gradethread.com")
    }

    func test_theGeoTimeoutIsBoundedSoAnalyticsIsNotHeldBackForever() {
        XCTAssertGreaterThan(GeoService.timeout, 0)
        XCTAssertLessThanOrEqual(GeoService.timeout, 10)
    }
}
