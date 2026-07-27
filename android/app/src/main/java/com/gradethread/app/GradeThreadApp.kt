package com.gradethread.app

import android.app.Application
import androidx.work.Configuration
import com.gradethread.app.platform.AppConfig
import com.gradethread.app.platform.applock.AppLock
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.auth.AuthRepository
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.ConnectivityMonitor
import com.gradethread.app.sync.SyncTrigger
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
        // The session tail AuthRepository documents ("call once from the app
        // scope") had no caller, so phase never left Loading. Sync's sign-in
        // trigger depends on it.
        authRepository.start(appScope)
        // US-2151: sync on cold start, on every return from background, and on
        // sign-in. Until this existed the pull primitives had no caller at all,
        // so Room was never populated and every screen rendered empty.
        syncTrigger.observeForeground()
        syncTrigger.observeSignIn(authRepository)
        // Reconnect. Each of these also flushes the offline mutation queue,
        // which until now was written to and never drained — see SyncTrigger's
        // note. Reconnect matters most for the queue: a seller working through a
        // dead spot never backgrounds the app, so no foreground event fires.
        syncTrigger.observeConnectivity(ConnectivityMonitor(this))
    }

    /** Lives as long as the process — these observers never unsubscribe. */
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Inject
    lateinit var syncTrigger: SyncTrigger

    @Inject
    lateinit var authRepository: AuthRepository
}
