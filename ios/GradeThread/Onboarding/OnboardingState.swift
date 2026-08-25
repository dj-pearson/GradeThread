import Foundation

/// US-747: posted when onboarding finishes with a chosen use case, so a live
/// signed-in shell can route to the fitting first action immediately. The
/// persisted `pendingFirstAction` flag is the fallback when onboarding finished
/// before the user signed in (no shell mounted to receive the notification).
extension Notification.Name {
    static let onboardingDidFinish = Notification.Name("com.gradethread.app.onboardingDidFinish")
    /// US-2875: Settings asked to see the carousel again. `showingOnboarding`
    /// in ContentView is `@State` seeded ONCE at view init, so clearing the
    /// stored flag on its own would not show anything until the next cold
    /// launch -- which is indistinguishable from the button doing nothing.
    static let onboardingReplayRequested = Notification.Name("com.gradethread.app.onboardingReplayRequested")
}

/// US-747: the new user's self-identified focus, captured in onboarding. Drives
/// the first-action routing and can inform later surfacing. Mirrors the spirit
/// of the web USE_CASES (US-742), tailored to the iOS surfaces.
enum OnboardingUseCase: String, CaseIterable, Identifiable, Codable {
    /// High-volume reseller → straight into batch AutoLister.
    case reseller
    /// Casual seller / grader → snap & grade one item.
    case grader
    /// Existing storefront → connect eBay and sync.
    case store

    var id: String { rawValue }

    var title: String {
        switch self {
        case .reseller: return "I resell at volume"
        case .grader:   return "I grade & sell a few"
        case .store:    return "I run an eBay store"
        }
    }

    var subtitle: String {
        switch self {
        case .reseller: return "Batch-photograph a pile and let AI draft every listing at once."
        case .grader:   return "Snap one garment, get a certified condition grade to sell with."
        case .store:    return "Connect eBay to sync listings, orders, and payouts both ways."
        }
    }

    var systemImage: String {
        switch self {
        case .reseller: return "square.stack.3d.up.fill"
        case .grader:   return "camera.viewfinder"
        case .store:    return "antenna.radiowaves.left.and.right"
        }
    }

    /// Where onboarding drops this user first. `intake` is pushed onto the
    /// landing tab's stack when present (Home hosts the intake destinations).
    var firstAction: (section: AppSection, intake: IntakeRoute?) {
        switch self {
        case .reseller: return (.home, .autoLister)
        case .grader:   return (.home, .photoFirst)
        case .store:    return (.marketplaces, nil)
        }
    }
}

/// Persists whether the first-run onboarding has been completed. UserDefaults-
/// backed so it survives launches and only ever shows once. The `defaults`
/// dependency is injectable so the flag logic is unit-testable in isolation.
///
/// The key is versioned (`.v1`) so a future redesign can re-introduce
/// onboarding to existing users by bumping the suffix.
struct OnboardingState {
    static let key = "com.gradethread.app.onboarding.completed.v1"
    static let useCaseKey = "com.gradethread.app.onboarding.useCase.v1"
    static let pendingFirstActionKey = "com.gradethread.app.onboarding.pendingFirstAction.v1"
    /// US-2875: set while a REPLAY is on screen, so `complete` knows not to
    /// queue a first action. Not versioned like the others: it is transient
    /// state that lives for one pass through the carousel, not a record of
    /// anything.
    static let replayingKey = "com.gradethread.app.onboarding.replaying"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hasCompleted: Bool {
        get { defaults.bool(forKey: Self.key) }
        nonmutating set { defaults.set(newValue, forKey: Self.key) }
    }

    /// US-747: the captured use case (nil if skipped). Persisted so it survives
    /// launches and can inform later surfacing.
    var selectedUseCase: OnboardingUseCase? {
        get { defaults.string(forKey: Self.useCaseKey).flatMap(OnboardingUseCase.init(rawValue:)) }
        nonmutating set {
            if let value = newValue {
                defaults.set(value.rawValue, forKey: Self.useCaseKey)
            } else {
                defaults.removeObject(forKey: Self.useCaseKey)
            }
        }
    }

    /// US-747: a one-shot flag — true once onboarding finishes with a use case,
    /// cleared the moment the shell performs the first-action routing, so it
    /// runs exactly once even across the notification + appear-fallback paths.
    var pendingFirstAction: Bool {
        get { defaults.bool(forKey: Self.pendingFirstActionKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.pendingFirstActionKey) }
    }

    /// US-2875: true while a replay is on screen.
    var isReplaying: Bool {
        get { defaults.bool(forKey: Self.replayingKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.replayingKey) }
    }

    /// US-2875: show the carousel again, on purpose.
    ///
    /// It clears `hasCompleted` and NOTHING ELSE. The recorded use case stays —
    /// somebody rewatching the intro has not stopped being a reseller, and
    /// wiping it would silently re-persona them. `pendingFirstAction` stays
    /// untouched too; see `complete` for why that matters.
    func replay() {
        hasCompleted = false
        isReplaying = true
        NotificationCenter.default.post(name: .onboardingReplayRequested, object: nil)
    }

    /// US-747: finalize onboarding — mark complete, record the use case, queue
    /// the one-shot first action, and notify any live shell to route now.
    func complete(useCase: OnboardingUseCase?) {
        hasCompleted = true
        selectedUseCase = useCase
        // US-1178: queue a first action even on skip (nil useCase) so the shell
        // can offer a gentle "add your first item" nudge instead of landing the
        // user on a bare dashboard with nothing to do.
        //
        // US-2875: EXCEPT on a replay. pendingFirstAction routes the shell to
        // another tab, which is the right welcome for a brand-new account and
        // completely wrong for somebody who tapped "Replay tour" in Settings
        // while halfway through something. A first-run nudge that yanks a
        // working user out of what they were doing is worse than no nudge.
        if isReplaying {
            isReplaying = false
        } else {
            pendingFirstAction = true
        }
        NotificationCenter.default.post(name: .onboardingDidFinish, object: nil)
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
