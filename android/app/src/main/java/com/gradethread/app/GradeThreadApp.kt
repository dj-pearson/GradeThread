package com.gradethread.app

import android.app.Application
import com.gradethread.app.platform.AppConfig
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.HiltAndroidApp

/**
 * US-1300: Hilt application root. Feature graph modules install into this
 * SingletonComponent as they land (networking, sync, telemetry…).
 */
@HiltAndroidApp
class GradeThreadApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // US-1301: a build with a missing/cleartext base URL dies HERE with a
        // named error, not deep inside the first network call.
        AppConfig.validateAtStartup()
        // US-1308: crash reporting (DSN-gated) + opt-out-respecting analytics.
        Telemetry.bootstrap(this)
    }
}
