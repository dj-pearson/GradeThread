import Foundation

/// Central reader for the hermetic UI-test launch arguments (US-1153).
///
/// Every hook is compiled into **every** build but only activates when the
/// XCUITest runner passes the matching `-uitest-*` launch argument, so a normal
/// (non-test) launch never trips any of them — `ProcessInfo.arguments` carries
/// the flag only when the test harness injects it via `app.launchArguments`.
/// This keeps the critical-flow tests offline + deterministic (no live network,
/// no App Store Connect, no Anthropic round-trip, no credits spent) without a
/// separate test-only build configuration.
///
/// Wiring:
///   - `resetAuthState`  → ``GradeThreadApp`` wipes the keychain at launch so the
///     sign-in journey always starts cold at ``LoginView``.
///   - `directToPaywall` → ``ProtectedRouteShell`` presents ``PaywallView``
///     directly (StoreKit prices come from the scheme's `GradeThread.storekit`
///     configuration), so the purchase flow is reachable without a backend
///     session.
///   - `mockGrading`     → ``GradingService`` returns a canned, completed grade
///     report instead of calling the FlipDesk → GradeThread bridge.
enum UITestSupport {

    /// True for ANY hermetic UI-test launch (the runner always passes `-uitest`
    /// alongside the more specific flags). Gates the cheaper hooks so they can
    /// never fire in a production launch even if a specific flag were somehow
    /// present.
    static let isRunningUITests: Bool = flag("-uitest")

    /// Force a signed-out cold start: clear any restored Supabase session +
    /// keychain so the sign-in journey test always begins at ``LoginView``.
    static let resetAuthState: Bool = isRunningUITests && flag("-uitest-reset-auth")

    /// Present the paywall directly at launch so the StoreKit purchase journey
    /// is reachable without a signed-in backend session. Prices/products resolve
    /// from the scheme's attached `.storekit` configuration.
    static let directToPaywall: Bool = isRunningUITests && flag("-uitest-paywall")

    /// Stub the grading network so capture → grade → draft is deterministic and
    /// offline (no Anthropic round-trip, no credits spent). ``GradingService``
    /// returns a canned, completed report keyed to the requested item/tier.
    static let mockGrading: Bool = isRunningUITests && flag("-uitest-mock-grading")

    /// Stable placeholder user id for surfaces (e.g. the StoreKit
    /// `appAccountToken`) that need one when no session exists. Fixed so a test
    /// run is reproducible.
    static let stubUserId = UUID(uuidString: "00000000-0000-0000-0000-0000000017A3")!

    private static func flag(_ name: String) -> Bool {
        ProcessInfo.processInfo.arguments.contains(name)
    }
}
