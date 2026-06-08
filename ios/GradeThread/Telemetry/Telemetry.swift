import Foundation
import PostHog
import Sentry

/// Thin facade over Sentry + PostHog so call sites instrument the same way
/// regardless of which provider does what. Three rules baked in:
///
///   1. **Sentry is always on** when the DSN is configured. Crashes are
///      errors, not analytics — they don't respect the opt-in toggle.
///   2. **PostHog respects the opt-in toggle.** Every `event(...)` and
///      `setUser(...)` no-ops when `Telemetry.isAnalyticsEnabled` is
///      false. Sentry breadcrumbs still fire because they ride along
///      with crash reports.
///   3. **Missing DSN / API key disables silently.** xcconfig
///      placeholders come through as empty strings; we treat that as
///      "this build wasn't configured for telemetry" rather than
///      crashing.
@MainActor
public enum Telemetry {

    private static let analyticsToggleKey = "com.gradethread.app.analytics.enabled"
    private static var didInitialize = false

    /// User-facing opt-in. Default ON; flipping false stops PostHog
    /// events (Sentry crashes still go through — that's the AC).
    public static var isAnalyticsEnabled: Bool {
        get {
            UserDefaults.standard.object(forKey: analyticsToggleKey)
                .flatMap { ($0 as? Bool) } ?? true
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
        startSentry()
        startPostHog()
    }

    // MARK: - User context

    /// Stamps the current user on Sentry (always) and PostHog (when
    /// analytics opt-in is on). `id` should be auth.uid — no PII per
    /// the AC.
    public static func setUser(id: String, email: String?) {
        if AppConfig.sentryDSN != nil {
            let user = User()
            user.userId = id
            // Email omitted per AC — Sentry user context is auth.uid only.
            SentrySDK.setUser(user)
        }
        if isAnalyticsEnabled, AppConfig.postHogAPIKey != nil {
            PostHogSDK.shared.identify(id)
        }
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
    public static func event(_ name: String, props: [String: Any] = [:]) {
        guard isAnalyticsEnabled, AppConfig.postHogAPIKey != nil else { return }
        PostHogSDK.shared.capture(name, properties: props)
    }

    /// Crash-report breadcrumb. Routes to Sentry even when analytics is
    /// off so we still get pre-crash context. No-op when Sentry DSN
    /// isn't configured.
    public static func breadcrumb(_ message: String, category: String) {
        guard AppConfig.sentryDSN != nil else { return }
        let crumb = Breadcrumb()
        crumb.message = message
        crumb.category = category
        crumb.level = .info
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
    /// `nonisolated` because Sentry's `beforeSend` / `beforeBreadcrumb` hooks
    /// invoke it from a synchronous, non-isolated context — and it touches no
    /// main-actor state (only the `Breadcrumb` arg + the pure
    /// `TelemetryScrubber.redact`).
    nonisolated static func scrubBreadcrumb(_ crumb: Breadcrumb) {
        crumb.message = crumb.message.map(TelemetryScrubber.redact)
        crumb.data = scrubbedBreadcrumbData(crumb.data)
    }

    /// Pure redaction of a breadcrumb's structured `data`: every string value is
    /// run through ``TelemetryScrubber`` (non-strings pass through). Split out so
    /// it's unit-testable without importing Sentry's `Breadcrumb` type.
    nonisolated static func scrubbedBreadcrumbData(_ data: [String: Any]?) -> [String: Any]? {
        guard let data else { return nil }
        return data.mapValues { value in
            if let string = value as? String {
                return TelemetryScrubber.redact(string)
            }
            return value
        }
    }

    private static func startPostHog() {
        guard let apiKey = AppConfig.postHogAPIKey else { return }
        let config = PostHogConfig(
            apiKey: apiKey,
            host: AppConfig.postHogHost.absoluteString
        )
        // Capture screen-views automatically — saves us instrumenting
        // every NavigationLink push manually.
        config.captureApplicationLifecycleEvents = true
        config.captureScreenViews = true
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
