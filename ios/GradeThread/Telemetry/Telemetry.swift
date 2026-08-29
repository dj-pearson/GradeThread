import Foundation
import PostHog
import Sentry

/// Thin facade over Sentry + PostHog so call sites instrument the same way
/// regardless of which provider does what. Four rules baked in:
///
///   1. **Sentry is always on** when the DSN is configured. Crashes are
///      errors, not analytics — they don't respect the opt-in toggle.
///   2. **PostHog respects the analytics toggle (opt-out, on by
///      default).** Every `event(...)`,
///      `screen(...)`, and `setUser(...)` no-ops when
///      `Telemetry.isAnalyticsEnabled` is false. Sentry breadcrumbs still
///      fire because they ride along with crash reports.
///   3. **Missing DSN / API key disables silently.** xcconfig
///      placeholders come through as empty strings; we treat that as
///      "this build wasn't configured for telemetry" rather than
///      crashing.
///   4. **PostHog never receives free-text PII (US-991).** Unlike Sentry —
///      which scrubs every message/breadcrumb in `beforeSend` /
///      `beforeBreadcrumb` — PostHog has no such hook, so it would
///      otherwise forward whatever a call site passed verbatim. Two
///      defenses close that gap:
///        - **No screen autocapture.** `captureScreenViews` is OFF, so a
///          SwiftUI navigation title carrying an item title or consignor
///          name can never become a PostHog screen name. Record screens
///          explicitly via `screen(_:)` using a STABLE, non-PII id.
///        - **Property scrubbing.** Every `event(...)` / `screen(...)`
///          property value is run through `TelemetryScrubber` (emails,
///          tokens, signed Storage URLs) before it reaches PostHog. The
///          standing contract remains that call sites pass ids/enums/counts
///          — never a free-text item or consignor name — and this scrub is
///          the safety net, not a license to send PII.
///
/// **Consent (US-191 / US-991):** product analytics is opt-out — default ON,
/// surfaced to the user in Settings → Analytics ("Share product analytics")
/// where flipping it off both stops every PostHog call and `reset()`s the
/// in-memory session. Crash reporting (Sentry) is independent and stays on;
/// the toggle footer says so explicitly.
@MainActor
public enum Telemetry {

    private static let analyticsToggleKey = "com.gradethread.app.analytics.enabled"
    private static var didInitialize = false

    /// The regime resolved at launch, or nil while the lookup is still running.
    ///
    /// nil means UNRESOLVED and is treated as `.optIn` everywhere it is read,
    /// which is the same fail-safe the other two clients use: the window before
    /// the answer arrives must not be the permissive one.
    private static var resolvedRegime: ConsentRegime?

    /// What the seller has actually said, TRI-STATE.
    ///
    /// nil is the case that used to be hard-coded to "on": never asked, never
    /// touched the toggle, so the regime decides. An explicit false is never
    /// overridden by an opt-out jurisdiction, and an explicit true is honoured
    /// in an opt-in one.
    static var explicitAnalyticsChoice: Bool? {
        UserDefaults.standard.object(forKey: analyticsToggleKey).flatMap { $0 as? Bool }
    }

    /// User-facing analytics toggle.
    ///
    /// US-2914: no longer "on by default". The answer is the seller's own
    /// choice when they have made one, and otherwise the consent regime for
    /// where they are - opt-in everywhere except the US, and opt-in whenever
    /// the country is unknown. `?? true` is the expression that was here and
    /// is precisely what was wrong; `?? false` would be a different wrong
    /// answer, silently opting a US seller out of something they never objected
    /// to while the store privacy forms say analytics is collected there.
    ///
    /// Sentry is unaffected - crash reporting is operational rather than
    /// product analytics, is declared non-optional in both stores' privacy
    /// forms, and a crash in the first second of a cold start is the one most
    /// worth having.
    public static var isAnalyticsEnabled: Bool {
        get {
            Consent.analyticsAllowed(
                regime: resolvedRegime ?? .optIn,
                explicitChoice: explicitAnalyticsChoice
            )
        }
        set {
            UserDefaults.standard.set(newValue, forKey: analyticsToggleKey)
            if !newValue {
                // Drop the in-memory PostHog session so subsequent
                // app-open events from outside our control don't
                // sneak through.
                PostHogSDK.shared.reset()
            }
        }
    }

    /// Called once at AppDelegate launch. Idempotent — subsequent calls
    /// are no-ops so the singletons aren't double-initialized.
    public static func bootstrap() {
        guard !didInitialize else { return }
        didInitialize = true
        // Sentry FIRST and unconditionally (DSN permitting). It is not gated on
        // the regime: crash reporting is operational, and the crash most worth
        // having is the one in the first second of a cold start - which is
        // inside the window the geo lookup occupies.
        startSentry()
        // PostHog waits for the regime. Starting it first and stopping it later
        // would mean events already sent for a seller the answer turns out to
        // protect, which is the whole defect.
        Task { @MainActor in
            await resolveConsentRegime()
            if isAnalyticsEnabled { startPostHog() }
        }
    }

    /// Resolve the consent regime once, from the coarse country signal.
    ///
    /// Separated from `bootstrap` so a test can drive it, and so the Settings
    /// toggle has something to await rather than reading a value that has not
    /// settled yet.
    static func resolveConsentRegime() async {
        guard resolvedRegime == nil else { return }
        let geo = await GeoService.shared.signal()
        resolvedRegime = Consent.regime(for: geo)
    }

    /// Test hook: set the regime without a network call.
    static func setResolvedRegimeForTests(_ regime: ConsentRegime?) {
        resolvedRegime = regime
    }

    // MARK: - User context

    /// Stamps the current user on Sentry (always) and PostHog (when the
    /// analytics toggle is on — opt-out, on by default). `id` should be
    /// auth.uid — no PII.
    ///
    /// Deliberately takes NO email (or any other PII). Email is not a
    /// parameter at all so a future refactor can't reintroduce it by
    /// wiring `user.email` into the call site; `makeSentryUser` is the
    /// single construction point and is covered by a test that asserts
    /// the Sentry user never carries an email.
    public static func setUser(id: String) {
        if AppConfig.sentryDSN != nil {
            SentrySDK.setUser(makeSentryUser(id: id))
        }
        if isAnalyticsEnabled, AppConfig.postHogAPIKey != nil {
            PostHogSDK.shared.identify(id)
        }
    }

    /// Builds the Sentry user context. The single place a `Sentry.User`
    /// is constructed for `setUser`, so the no-PII invariant is testable:
    /// only `userId` (auth.uid) is set — `email`/`username`/`ipAddress`
    /// are intentionally left nil.
    static func makeSentryUser(id: String) -> User {
        let user = User()
        user.userId = id
        return user
    }

    /// Clears user context on sign-out so the next user's events don't
    /// blend into the previous user's funnel.
    public static func clearUser() {
        SentrySDK.setUser(nil)
        PostHogSDK.shared.reset()
    }

    // MARK: - Events

    /// Tracked analytics event. No-op when analytics is disabled or the
    /// PostHog SDK never initialized (missing API key).
    ///
    /// Every string property value is redacted via `TelemetryScrubber`
    /// (US-991) so a token / email / signed Storage URL that slips into a
    /// payload is stripped the same way Sentry messages are — PostHog has no
    /// `beforeSend` hook of its own.
    public static func event(_ name: String, props: [String: Any] = [:]) {
        guard isAnalyticsEnabled, AppConfig.postHogAPIKey != nil else { return }
        PostHogSDK.shared.capture(name, properties: redactProperties(props))
    }

    /// Explicit screen view with a STABLE, non-PII identifier. Auto
    /// screen-view capture is disabled (`captureScreenViews = false`)
    /// precisely so SwiftUI navigation titles — which frequently contain
    /// free-text item titles or consignor names — never leak as PostHog
    /// screen names. Pass a constant from `TelemetryScreen`, never a
    /// user-derived string. Properties are scrubbed exactly like `event`.
    public static func screen(_ name: String, props: [String: Any] = [:]) {
        guard isAnalyticsEnabled, AppConfig.postHogAPIKey != nil else { return }
        PostHogSDK.shared.screen(name, properties: redactProperties(props))
    }

    /// US-991: run every string property value through `TelemetryScrubber`,
    /// recursing into nested arrays/dictionaries, before it reaches PostHog.
    /// `nonisolated` + pure so it's trivially testable and has no main-actor
    /// dependency.
    nonisolated static func redactProperties(_ props: [String: Any]) -> [String: Any] {
        redactDict(props)
    }

    /// Recursively redact a `[String: Any]` payload, passing each key down so a
    /// sensitive-header value (e.g. a nested `["apikey": "<token>"]` request-
    /// header dict from a swizzled HTTP breadcrumb) is dropped wholesale, not
    /// just pattern-matched. (US-990)
    nonisolated static func redactDict(_ dict: [String: Any]) -> [String: Any] {
        dict.reduce(into: [String: Any]()) { acc, pair in
            acc[pair.key] = redactValue(pair.value, key: pair.key)
        }
    }

    nonisolated private static func redactValue(_ value: Any, key: String? = nil) -> Any {
        // A value keyed by a sensitive header name is a raw token with no
        // surrounding context for the string rules — redact it wholesale.
        if let key, TelemetryScrubber.isSensitiveHeaderName(key), value is String {
            return "[redacted]"
        }
        switch value {
        case let string as String:
            return TelemetryScrubber.redact(string)
        case let array as [Any]:
            return array.map { redactValue($0) }
        case let dict as [String: Any]:
            return redactDict(dict)
        default:
            return value
        }
    }

    /// Crash-report breadcrumb. Intentionally NOT gated on the analytics
    /// opt-out toggle, and that's a deliberate privacy decision, not an
    /// oversight (US-1014):
    ///
    ///   - A breadcrumb is not an analytics event. It never leaves the
    ///     device on its own — it is only transmitted *attached to* a
    ///     crash/error report, which is the always-on Sentry channel
    ///     (crashes are errors, not analytics; see the type-level docs).
    ///   - Every breadcrumb is PII/token/URL-scrubbed via
    ///     `beforeBreadcrumb` (`scrubBreadcrumb`) before it can be
    ///     persisted or sent, so opting out of analytics doesn't expose
    ///     anything a breadcrumb could leak.
    ///   - Gating breadcrumbs on the analytics toggle would silently
    ///     degrade crash diagnostics for opted-out users without any
    ///     corresponding privacy gain.
    ///
    /// No-op when the Sentry DSN isn't configured.
    public static func breadcrumb(_ message: String, category: String) {
        Self.addBreadcrumb(message, category: category, level: .info)
    }

    /// Nonisolated breadcrumb for off-main-actor call sites — the
    /// `SyncMergeActor` (a plain `actor`), the nonisolated `OfflineMutationQueue`,
    /// and the `ModelContext.saveOrLog` persistence helper (US-1142) all need to
    /// breadcrumb without an `await MainActor.run` hop. Logged at `.warning`
    /// since these are failure paths. Safe off the main thread:
    /// `SentrySDK.addBreadcrumb` is thread-safe, `AppConfig` is a plain enum, and
    /// the `beforeBreadcrumb` hook still scrubs PII before the crumb is stored.
    nonisolated public static func backgroundBreadcrumb(_ message: String, category: String) {
        Self.addBreadcrumb(message, category: category, level: .warning)
    }

    /// Single construction point for both the main-actor and nonisolated
    /// breadcrumb entry points so the DSN guard + scrubbing contract live in one
    /// place. `nonisolated` because `backgroundBreadcrumb` calls it off-main.
    nonisolated private static func addBreadcrumb(
        _ message: String, category: String, level: SentryLevel
    ) {
        guard AppConfig.sentryDSN != nil else { return }
        let crumb = Breadcrumb()
        crumb.message = message
        crumb.category = category
        crumb.level = level
        crumb.timestamp = .now
        SentrySDK.addBreadcrumb(crumb)
    }

    // MARK: - Internals

    private static func startSentry() {
        guard let dsn = AppConfig.sentryDSN else { return }
        SentrySDK.start { options in
            options.dsn = dsn
            options.tracesSampleRate = 0.2
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.enableUserInteractionTracing = false
            options.enableSwizzling = true
            options.enableAutoPerformanceTracing = true
            // Distinguish dev/release in the dashboard.
            options.environment = PushService.environmentName
            // US-662 + US-695: scrub PII / tokens / signed Storage URLs out of
            // every event message AND breadcrumb (message *and* structured
            // `data`) before it leaves the device. The auto HTTP-breadcrumbs
            // from `enableSwizzling` store the request URL in `crumb.data["url"]`
            // / `["http.url"]`, which the message-only scrub never touched.
            options.beforeSend = { event in
                if let message = event.message {
                    // SDK drift: `formatted` is now a get-only String (and
                    // `message` is optional), so rebuild the message from the
                    // redacted formatted text — that's the string Sentry
                    // displays/sends, so scrubbing it covers the PII exposure.
                    event.message = SentryMessage(
                        formatted: TelemetryScrubber.redact(message.formatted))
                }
                event.breadcrumbs?.forEach(scrubBreadcrumb)
                return event
            }
            options.beforeBreadcrumb = { crumb in
                scrubBreadcrumb(crumb)
                return crumb
            }
        }
    }

    /// US-695: redact a breadcrumb's message and every string value in its
    /// structured `data` (notably `url` / `http.url` from swizzled networking
    /// breadcrumbs, which can carry signed-storage tokens or bearer creds).
    ///
    /// `nonisolated` because Sentry's `beforeSend` / `beforeBreadcrumb` hooks run
    /// off the main actor, and this is pure work (mutates the passed-in crumb,
    /// calls the nonisolated `TelemetryScrubber.redact`) with no main-actor
    /// state — so it must not inherit the enum's `@MainActor` isolation.
    nonisolated static func scrubBreadcrumb(_ crumb: Breadcrumb) {
        crumb.message = crumb.message.map(TelemetryScrubber.redact)
        guard let data = crumb.data else { return }
        // Recurse + key-aware: swizzled HTTP breadcrumbs stash the request URL in
        // `http.url` (signed-storage token) and may nest a request-header dict
        // whose `Authorization` / `apikey` values are raw tokens.
        crumb.data = redactDict(data)
    }

    private static func startPostHog() {
        guard let apiKey = AppConfig.postHogAPIKey else { return }
        let config = PostHogConfig(
            apiKey: apiKey,
            host: AppConfig.postHogHost.absoluteString
        )
        // Lifecycle events (app open/background/install/update) carry no
        // user-supplied text, so autocapture is safe and useful.
        config.captureApplicationLifecycleEvents = true
        // US-991: screen autocapture is OFF. SwiftUI navigation titles
        // frequently contain free-text item titles / consignor names, and
        // PostHog would forward them verbatim as screen names (no scrubber).
        // Record screens explicitly via `Telemetry.screen(_:)` with a stable,
        // non-PII id from `TelemetryScreen` instead.
        config.captureScreenViews = false
        PostHogSDK.shared.setup(config)
    }
}

/// Named keys for the recurring events the AC calls out. String
/// constants prevent typos drifting between call sites and the
/// PostHog dashboard.
public enum TelemetryEvent {
    public static let appOpen = "app_open"
    public static let intakeCompleted = "intake_completed"
    public static let aiExtractUsed = "ai_extract_used"
    public static let ebaySynced = "ebay_synced"
    public static let listingPublished = "listing_published"
    public static let saleRecorded = "sale_recorded"
}

/// Stable, non-PII screen identifiers for explicit `Telemetry.screen(_:)`
/// calls. Auto screen-view capture is OFF (US-991) so screen names can never
/// be derived from free-text navigation titles; these constants are the only
/// approved screen labels and must stay stable so PostHog funnels don't split.
public enum TelemetryScreen {
    public static let pipeline = "pipeline"
    public static let intake = "intake"
    public static let aiExtract = "ai_extract"
    public static let grading = "grading"
    public static let marketplaces = "marketplaces"
    public static let analytics = "analytics"
    public static let settings = "settings"
    public static let paywall = "paywall"
}
