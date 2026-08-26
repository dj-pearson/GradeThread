package com.gradethread.app.platform.telemetry

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import com.gradethread.app.platform.AppConfig
import com.posthog.PostHog
import com.posthog.android.PostHogAndroid
import com.posthog.android.PostHogAndroidConfig
import io.sentry.Breadcrumb
import io.sentry.Sentry
import io.sentry.SentryLevel
import io.sentry.android.core.SentryAndroid
import io.sentry.protocol.User
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private val Context.telemetryDataStore by preferencesDataStore(name = "telemetry")

/**
 * US-1308: the telemetry facade (iOS Telemetry, US-662). Rules carried over:
 *  - CRASH reporting (Sentry) is always-on when a DSN exists — independent of
 *    the analytics toggle (crashes are operational, not product analytics);
 *  - PRODUCT analytics (PostHog) honors the seller's stored choice, and when
 *    they have not made one the CONSENT REGIME decides (US-2897) - opt-in
 *    everywhere except the US, mirroring src/lib/consent-regime.ts;
 *  - a missing DSN / key disables that half silently (AppConfig empty
 *    placeholders read as absent);
 *  - identity is ONLY the Supabase user id — never email/name;
 *  - NO screen autocapture: screens are named manually, because autocaptured
 *    view hierarchies would leak item titles / consignor names;
 *  - every string is scrubbed by [TelemetryScrubber] before the wire.
 */
object Telemetry {

    private val OPT_OUT_KEY = booleanPreferencesKey("analytics_opt_out")

    /**
     * US-2897: OBSERVABLE, not just a volatile flag.
     *
     * Analytics now starts asynchronously — after a DataStore read and, for a
     * seller who has never chosen, a geo lookup. The Settings toggle used to
     * read this once when its ViewModel was built, which after this change
     * would render "off" and stay there while analytics quietly came on a
     * moment later. A toggle that disagrees with what the app is doing is
     * worse than no toggle on a privacy screen.
     */
    private val analyticsState = MutableStateFlow(false)

    /** The live state of product analytics. */
    val analyticsEnabledFlow: StateFlow<Boolean> = analyticsState.asStateFlow()

    private var analyticsEnabled: Boolean
        get() = analyticsState.value
        set(value) {
            analyticsState.value = value
        }

    @Volatile
    private var appContext: Context? = null

    /**
     * Call once from Application.onCreate.
     *
     * US-2897: NO LONGER BLOCKS, and no longer assumes consent.
     *
     * It used to do `runBlocking { dataStore.first() }` on the main thread and
     * start PostHog unless an opt-out was already stored — so on a fresh
     * install analytics was running before the first screen drew and before
     * anyone had been asked. Now the seller's stored choice is TRI-STATE and
     * the regime decides when they have not made one; see [Consent].
     *
     * Sentry still starts synchronously and unconditionally (DSN permitting).
     * Crash reporting is operational rather than product analytics, it is
     * declared non-optional in the Play Data safety form, and a crash in the
     * first second of a cold start is exactly the one worth having.
     *
     * [scope] is the application scope, so this outlives any screen. Nothing
     * user-facing waits on it: the only thing gated is whether events are
     * captured, and events before it resolves are simply not captured — which
     * is the correct outcome for a seller who may turn out to be in an opt-in
     * jurisdiction. (This also removes one of the two main-thread DataStore
     * reads US-2900 AC2 is about; AppLock's is the other.)
     */
    fun bootstrap(context: Context, scope: CoroutineScope) {
        appContext = context.applicationContext
        startSentry(context)
        scope.launch {
            val stored = storedChoice(context)
            val regime = Consent.regimeFor(
                // Only ask where the seller is when it can change the answer.
                // An explicit choice already settles it, and resolving geo
                // anyway would be a location lookup with no purpose.
                if (stored == null) GeoService.signal() else null,
            )
            if (Consent.analyticsAllowed(regime, stored)) startPostHog(context)
        }
    }

    /**
     * The seller's own choice, or null if they have never made one.
     *
     * Absent key means never asked — NOT "opted in". That distinction is the
     * whole of this change: the old code read a missing key as consent.
     */
    internal suspend fun storedChoice(context: Context): Boolean? =
        context.telemetryDataStore.data.first()[OPT_OUT_KEY]?.let { !it }

    private fun startSentry(context: Context) {
        val dsn = AppConfig.sentryDsn ?: return // silently disabled
        SentryAndroid.init(context) { options ->
            options.dsn = dsn
            options.isSendDefaultPii = false
            options.beforeSend = io.sentry.SentryOptions.BeforeSendCallback { event, _ ->
                event.message?.let { msg ->
                    msg.formatted = msg.formatted?.let(TelemetryScrubber::redact)
                    msg.message = msg.message?.let(TelemetryScrubber::redact)
                }
                event
            }
            options.beforeBreadcrumb =
                io.sentry.SentryOptions.BeforeBreadcrumbCallback { breadcrumb, _ ->
                    breadcrumb.message = breadcrumb.message?.let(TelemetryScrubber::redact)
                    breadcrumb
                }
        }
    }

    private fun startPostHog(context: Context) {
        val key = AppConfig.posthogApiKey ?: return // silently disabled
        val config = PostHogAndroidConfig(
            apiKey = key,
            host = AppConfig.posthogHost,
        ).apply {
            // US-1308 AC4: no screen autocapture — screens are named manually.
            captureScreenViews = false
            captureDeepLinks = false
            captureApplicationLifecycleEvents = true
        }
        PostHogAndroid.setup(context, config)
        analyticsEnabled = true
    }

    // ── Identity (id ONLY — never email) ──

    fun setUser(id: String) {
        if (AppConfig.sentryDsn != null) {
            Sentry.setUser(User().apply { this.id = id })
        }
        if (analyticsEnabled) PostHog.identify(id)
    }

    fun clearUser() {
        if (AppConfig.sentryDsn != null) Sentry.setUser(null)
        if (analyticsEnabled) PostHog.reset()
    }

    // ── Events / screens / breadcrumbs ──

    fun event(name: String, props: Map<String, Any?> = emptyMap()) {
        if (!analyticsEnabled) return
        PostHog.capture(name, properties = nonNull(TelemetryScrubber.redactProperties(props)))
    }

    /** Manually-named screen view (autocapture is off by design). */
    fun screen(name: String, props: Map<String, Any?> = emptyMap()) {
        if (!analyticsEnabled) return
        PostHog.screen(name, properties = nonNull(TelemetryScrubber.redactProperties(props)))
    }

    fun breadcrumb(message: String, category: String) {
        if (AppConfig.sentryDsn == null) return
        Sentry.addBreadcrumb(
            Breadcrumb().apply {
                this.message = TelemetryScrubber.redact(message)
                this.category = category
                level = SentryLevel.INFO
            },
        )
    }

    // ── Opt-out (analytics only; crash reporting stays) ──

    suspend fun setAnalyticsEnabled(context: Context, enabled: Boolean) {
        context.telemetryDataStore.edit { it[OPT_OUT_KEY] = !enabled }
        if (enabled && !analyticsEnabled) {
            startPostHog(context)
        } else if (!enabled && analyticsEnabled) {
            PostHog.reset()
            PostHog.close()
            analyticsEnabled = false
        }
    }

    fun isAnalyticsEnabled(): Boolean = analyticsEnabled

    private fun nonNull(props: Map<String, Any?>): Map<String, Any> =
        props.entries.mapNotNull { (k, v) -> v?.let { k to it } }.toMap()
}
