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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

private val Context.telemetryDataStore by preferencesDataStore(name = "telemetry")

/**
 * US-1308: the telemetry facade (iOS Telemetry, US-662). Rules carried over:
 *  - CRASH reporting (Sentry) is always-on when a DSN exists — independent of
 *    the analytics toggle (crashes are operational, not product analytics);
 *  - PRODUCT analytics (PostHog) honors the user's opt-out (default: enabled)
 *    persisted in DataStore;
 *  - a missing DSN / key disables that half silently (AppConfig empty
 *    placeholders read as absent);
 *  - identity is ONLY the Supabase user id — never email/name;
 *  - NO screen autocapture: screens are named manually, because autocaptured
 *    view hierarchies would leak item titles / consignor names;
 *  - every string is scrubbed by [TelemetryScrubber] before the wire.
 */
object Telemetry {

    private val OPT_OUT_KEY = booleanPreferencesKey("analytics_opt_out")

    @Volatile
    private var analyticsEnabled = false

    @Volatile
    private var appContext: Context? = null

    /** Call once from Application.onCreate. */
    fun bootstrap(context: Context) {
        appContext = context.applicationContext
        startSentry(context)
        // One small disk read at process start; the toggle is then in-memory.
        val optedOut = runBlocking {
            context.telemetryDataStore.data.first()[OPT_OUT_KEY] ?: false
        }
        if (!optedOut) startPostHog(context)
    }

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
