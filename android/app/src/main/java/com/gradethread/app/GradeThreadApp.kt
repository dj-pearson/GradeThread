package com.gradethread.app

import android.app.Application
import androidx.work.Configuration
import com.gradethread.app.platform.AppConfig
import com.gradethread.app.platform.applock.AppLock
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.SyncTrigger
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * US-1300: Hilt application root. Feature graph modules install into this
 * SingletonComponent as they land (networking, sync, telemetry…).
 */
@HiltAndroidApp
class GradeThreadApp : Application(), Configuration.Provider {

    /**
     * US-1328: cap upload parallelism at 3 (the iOS maxConcurrent) — this
     * executor runs ALL WorkManager work, and photo uploads are the app's
     * only WorkManager use, so the global cap IS the per-photo cap.
     */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setExecutor(java.util.concurrent.Executors.newFixedThreadPool(3))
            .build()

    override fun onCreate() {
        super.onCreate()
        // US-1301: a build with a missing/cleartext base URL dies HERE with a
        // named error, not deep inside the first network call.
        AppConfig.validateAtStartup()
        // US-1308: crash reporting (DSN-gated) + opt-out-respecting analytics.
        Telemetry.bootstrap(this)
        // US-1309: the workspace scope backs every X-Workspace-Owner header.
        WorkspaceScope.initialize(this)
        // US-1315: a cold launch with the lock enabled starts locked.
        AppLock.initialize(this)
        // US-2151: sync on cold start and on every return from background.
        // Until this existed the pull primitives had no caller at all, so
        // Room was never populated and every screen rendered empty.
        syncTrigger.observeForeground()
    }

    @Inject
    lateinit var syncTrigger: SyncTrigger
}
