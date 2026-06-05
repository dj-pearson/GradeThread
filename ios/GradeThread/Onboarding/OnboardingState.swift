import Foundation

/// Persists whether the first-run onboarding has been completed. UserDefaults-
/// backed so it survives launches and only ever shows once. The `defaults`
/// dependency is injectable so the flag logic is unit-testable in isolation.
///
/// The key is versioned (`.v1`) so a future redesign can re-introduce
/// onboarding to existing users by bumping the suffix.
struct OnboardingState {
    static let key = "com.gradethread.app.onboarding.completed.v1"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hasCompleted: Bool {
        get { defaults.bool(forKey: Self.key) }
        nonmutating set { defaults.set(newValue, forKey: Self.key) }
    }
}

/// One slide in the first-run carousel.
struct OnboardingPage: Identifiable {
    let id: Int
    let systemImage: String
    let title: String
    let body: String

    /// The reseller-facing intro: source → grade → list → track.
    static let pages: [OnboardingPage] = [
        OnboardingPage(
            id: 0,
            systemImage: "shippingbox.fill",
            title: "Your whole reselling flow",
            body: "Source, catalog, grade, list, and track sales — all in one workspace built for resellers."
        ),
        OnboardingPage(
            id: 1,
            systemImage: "camera.viewfinder",
            title: "Snap & catalog",
            body: "Photograph a garment and AI reads the brand, size, color, and condition right off the tag. Review, tweak, done."
        ),
        OnboardingPage(
            id: 2,
            systemImage: "checkmark.seal.fill",
            title: "Certified condition grades",
            body: "Get a standardized 1–10 grade and a shareable certificate buyers trust — fewer “not as described” returns."
        ),
        OnboardingPage(
            id: 3,
            systemImage: "chart.line.uptrend.xyaxis",
            title: "List & track profit",
            body: "Publish to eBay, sync listings both ways, and see what sold, what payout is coming, and your real profit."
        ),
    ]
}
