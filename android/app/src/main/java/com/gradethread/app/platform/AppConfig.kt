package com.gradethread.app.platform

import com.gradethread.app.BuildConfig

/**
 * US-1301: typed access to build-time configuration, mirroring the iOS
 * `AppConfig` (Debug/Release.xcconfig → Info.plist → typed accessors):
 *
 *  - values are injected as BuildConfig fields from local.properties / CI env
 *    (never committed — see app/build.gradle.kts `secret()`);
 *  - REQUIRED values (Supabase/Edge URLs, anon key) fail fast on first access
 *    when missing or non-https;
 *  - OPTIONAL values (Sentry, PostHog, Turnstile) read null when their
 *    placeholder is empty and the dependent feature disables silently.
 *
 * Endpoints (CLAUDE.md): Supabase = api.gradethread.com (Kong; ONLY Supabase
 * routes), Edge = functions.gradethread.com (ALL the Hono api routes) — mixing
 * them up 404s.
 */
object AppConfig {

    /** Self-hosted Supabase Kong base URL (auth, PostgREST, storage). */
    val supabaseUrl: String by lazy {
        ConfigValidation.requireHttpsBaseUrl("SUPABASE_URL", BuildConfig.SUPABASE_URL)
    }

    /** Public anon key — RLS enforces access; still sourced from secrets. */
    val supabaseAnonKey: String by lazy {
        ConfigValidation.requireNonBlank("SUPABASE_ANON_KEY", BuildConfig.SUPABASE_ANON_KEY)
    }

    /** Deno/Hono edge service base — every `api` route call goes here, never api.gradethread.com. */
    val edgeApiUrl: String by lazy {
        ConfigValidation.requireHttpsBaseUrl("EDGE_API_URL", BuildConfig.EDGE_API_URL)
    }

    /** Sentry DSN; null (empty placeholder) = crash reporting disabled. */
    val sentryDsn: String? get() = ConfigValidation.blankToNull(BuildConfig.SENTRY_DSN)

    /** PostHog key; null = analytics disabled. */
    val posthogApiKey: String? get() = ConfigValidation.blankToNull(BuildConfig.POSTHOG_API_KEY)

    /** PostHog host — defaults to the US cloud like iOS. */
    val posthogHost: String
        get() = ConfigValidation.blankToNull(BuildConfig.POSTHOG_HOST) ?: "https://us.i.posthog.com"

    /** Turnstile site key; null = the captcha step is skipped (local/CI). */
    val turnstileSiteKey: String? get() = ConfigValidation.blankToNull(BuildConfig.TURNSTILE_SITE_KEY)

    /** Debug builds log verbosely; release builds don't (US-1301 AC3). */
    val loggingEnabled: Boolean get() = BuildConfig.LOGGING_ENABLED

    /**
     * Startup validation (called from [com.gradethread.app.GradeThreadApp]):
     * forces the required lazy values so a misconfigured build dies at launch
     * with a named error instead of deep in the first network call.
     */
    fun validateAtStartup() {
        supabaseUrl
        supabaseAnonKey
        edgeApiUrl
    }
}
