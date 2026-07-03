package com.gradethread.app

import android.app.Application
import com.gradethread.app.platform.AppConfig
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.platform.workspace.WorkspaceScope
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
        // US-1309: the workspace scope backs every X-Workspace-Owner header.
        WorkspaceScope.initialize(this)
    }
}
