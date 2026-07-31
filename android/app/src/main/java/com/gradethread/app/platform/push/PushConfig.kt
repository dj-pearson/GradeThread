package com.gradethread.app.platform.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.gradethread.app.BuildConfig
import com.gradethread.app.platform.telemetry.Telemetry

/**
 * US-1378: Firebase, initialized by hand.
 *
 * There is deliberately NO `google-services` Gradle plugin and no
 * `google-services.json` in the repo. That plugin fails the build outright when
 * the file is missing, which would mean nobody could build this app — a fork, a
 * fresh clone, CI — without Firebase credentials that aren't ours to commit.
 *
 * Instead the four values arrive as BuildConfig fields like every other secret
 * (see `AppConfig`), and an unconfigured build simply has no push. That is the
 * same DSN-gated shape Sentry already uses here.
 */
object PushConfig {

    private fun value(raw: String): String? = raw.trim().takeIf { it.isNotEmpty() }

    val projectId: String? get() = value(BuildConfig.FIREBASE_PROJECT_ID)
    val appId: String? get() = value(BuildConfig.FIREBASE_APP_ID)
    val apiKey: String? get() = value(BuildConfig.FIREBASE_API_KEY)
    val senderId: String? get() = value(BuildConfig.FIREBASE_SENDER_ID)

    /**
     * All four, or none.
     *
     * A half-configured client initializes fine and then fails on the first
     * token request, which surfaces as "push doesn't work" with no clue why.
     * Refusing up front puts the reason in one place.
     */
    val configured: Boolean
        get() = projectId != null && appId != null && apiKey != null && senderId != null

    @Volatile
    private var initialized = false

    /**
     * Bring Firebase up if it can be. Safe to call more than once.
     *
     * Returns whether push is available, so the caller can skip registration
     * rather than queue work that can never succeed.
     */
    fun initialize(context: Context): Boolean {
        if (!configured) return false
        if (initialized) return true
        return runCatching {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context.applicationContext,
                    FirebaseOptions.Builder()
                        .setProjectId(projectId!!)
                        .setApplicationId(appId!!)
                        .setApiKey(apiKey!!)
                        .setGcmSenderId(senderId!!)
                        .build(),
                )
            }
            initialized = true
            true
        }.getOrElse { error ->
            // Never fatal. Push is a convenience; the app has to open without it.
            Telemetry.breadcrumb("firebase init failed: ${error.message}", "push")
            false
        }
    }
}
