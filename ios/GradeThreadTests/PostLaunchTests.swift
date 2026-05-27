import XCTest
@testable import GradeThread

@MainActor
final class PostLaunchTests: XCTestCase {

    private let installKey = "com.gradethread.app.review.installDate"
    private let listingsKey = "com.gradethread.app.review.listingsPublished"
    private let lastAskedKey = "com.gradethread.app.review.lastAskedAt"

    override func setUp() {
        super.setUp()
        ReviewPromptService.shared._resetForTesting()
    }

    override func tearDown() {
        ReviewPromptService.shared._resetForTesting()
        for flag in FeatureFlag.allCases {
            FeatureFlag._setOverride(flag, value: nil)
        }
        super.tearDown()
    }

    // MARK: - ReviewPromptService gating

    func test_review_notEligible_freshInstall() {
        XCTAssertFalse(ReviewPromptService.shared.isEligibleToPrompt())
    }

    func test_review_notEligible_publishesButTooNew() {
        let svc = ReviewPromptService.shared
        svc._setForTesting(installDaysAgo: 3, listingsPublished: 5)
        XCTAssertFalse(svc.isEligibleToPrompt(),
                       "3 days old, 5 listings — should fail the 14-day gate")
    }

    func test_review_notEligible_oldEnoughButTooFewListings() {
        let svc = ReviewPromptService.shared
        svc._setForTesting(installDaysAgo: 30, listingsPublished: 2)
        XCTAssertFalse(svc.isEligibleToPrompt(),
                       "30 days old, 2 listings — should fail the 3-listing gate")
    }

    func test_review_eligible_whenAllGatesMet() {
        let svc = ReviewPromptService.shared
        svc._setForTesting(installDaysAgo: 21, listingsPublished: 3)
        XCTAssertTrue(svc.isEligibleToPrompt())
    }

    func test_review_notEligible_recentlyAsked() {
        let svc = ReviewPromptService.shared
        svc._setForTesting(
            installDaysAgo: 200,
            listingsPublished: 10,
            lastAskedDaysAgo: 30
        )
        XCTAssertFalse(svc.isEligibleToPrompt(),
                       "Asked 30 days ago — must wait 365 between asks")
    }

    func test_review_eligible_lastAskedOverAYearAgo() {
        let svc = ReviewPromptService.shared
        svc._setForTesting(
            installDaysAgo: 800,
            listingsPublished: 50,
            lastAskedDaysAgo: 400
        )
        XCTAssertTrue(svc.isEligibleToPrompt())
    }

    func test_review_recordPublish_bumpsCounter() {
        let svc = ReviewPromptService.shared
        XCTAssertEqual(svc.listingsPublished, 0)
        svc.recordPublish()
        svc.recordPublish()
        svc.recordPublish()
        XCTAssertEqual(svc.listingsPublished, 3)
    }

    // MARK: - FeatureFlag override

    func test_featureFlag_defaultValues() {
        // Defaults are pinned per-case so a server outage or fresh
        // launch lands on a known cohort.
        XCTAssertFalse(FeatureFlag.photoFirstByDefault.defaultValue)
        XCTAssertFalse(FeatureFlag.bulkPriceDropMultiStep.defaultValue)
        XCTAssertTrue(FeatureFlag.showConfidenceBars.defaultValue)
    }

    func test_featureFlag_override_wins_over_default() {
        FeatureFlag._setOverride(.photoFirstByDefault, value: true)
        XCTAssertTrue(FeatureFlag.isEnabled(.photoFirstByDefault))

        FeatureFlag._setOverride(.photoFirstByDefault, value: false)
        XCTAssertFalse(FeatureFlag.isEnabled(.photoFirstByDefault))
    }

    func test_featureFlag_clearOverride_revertsToDefault() {
        FeatureFlag._setOverride(.showConfidenceBars, value: false)
        XCTAssertFalse(FeatureFlag.isEnabled(.showConfidenceBars))

        FeatureFlag._setOverride(.showConfidenceBars, value: nil)
        // Default is true and PostHog isn't initialized in tests, so
        // the resolution falls through to defaultValue.
        XCTAssertTrue(FeatureFlag.isEnabled(.showConfidenceBars))
    }

    func test_featureFlag_rawValues_pinnedToServerStrings() {
        // PostHog dashboards key off these strings — renaming silently
        // splits the cohort or returns nil server-side.
        XCTAssertEqual(FeatureFlag.photoFirstByDefault.rawValue, "photo_first_by_default")
        XCTAssertEqual(FeatureFlag.bulkPriceDropMultiStep.rawValue, "bulk_price_drop_multistep")
        XCTAssertEqual(FeatureFlag.showConfidenceBars.rawValue, "show_confidence_bars")
    }
}
