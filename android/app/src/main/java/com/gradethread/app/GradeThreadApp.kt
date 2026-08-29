package com.gradethread.app

import android.app.Application
import androidx.work.Configuration
import com.gradethread.app.platform.AppConfig
import com.gradethread.app.platform.applock.AppLock
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.auth.AuthRepository
import com.gradethread.app.billing.SubscriptionService
import com.gradethread.app.platform.push.PushConfig
import com.gradethread.app.platform.push.PushNotifier
import com.gradethread.app.platform.push.PushRegistration
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.intake.IntakeDrainer
import com.gradethread.app.sync.BackgroundRefreshStore
import com.gradethread.app.sync.BackgroundRefreshWorker
import com.gradethread.app.sync.ConnectivityMonitor
import com.gradethread.app.sync.RealtimeCoordinator
import com.gradethread.app.sync.SyncTrigger
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1300: Hilt application root. Feature graph modules install into this
 * SingletonComponent as they land (networking, sync, telemetry…).
 */
@HiltAndroidApp
class GradeThreadApp :
    Application(),
    Configuration.Provider {

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
        // US-1308: crash reporting (DSN-gated) + consent-respecting analytics.
        // US-2897: takes the app scope now — Sentry still starts inline, but
        // whether PostHog starts depends on the seller's stored choice and, if
        // they have not made one, on the consent regime for where they are.
        // That needs a network round trip, so it cannot happen on this thread.
        Telemetry.bootstrap(this, appScope)
        // US-1309: the workspace scope backs every X-Workspace-Owner header.
        WorkspaceScope.initialize(this)
        // US-1315: a cold launch with the lock enabled starts locked.
        // US-2900: takes the app scope now. The stored mode is read off the
        // main thread and MainActivity holds the splash until it lands, so the
        // first frame still cannot render unlocked - the guarantee is kept by
        // waiting rather than by blocking Application.onCreate on a file read.
        AppLock.initialize(this, appScope)
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
        // US-1366: Play pushes renewals and purchases made on another device
        // through the same listener as a fresh buy, with no screen open to
        // catch them. Without this the plan only moves when a webhook does.
        subscriptions.observe(appScope)
        // US-1378: channels first, so a seller who opens system settings before
        // their first push still sees what the app can send.
        PushNotifier.createChannels(this)
        if (PushConfig.initialize(this)) {
            // Re-registered on EVERY cold start, not only when the token
            // rotates: the server prunes stale tokens, and a client that only
            // registers on change would never come back after a prune.
            appScope.launch { pushRegistration.register() }
        }
        // US-2367: live inventory updates. RealtimeService has been complete
        // since US-1321 with NO caller, so the app had no realtime at all —
        // which looks exactly like a slow sync and so went unnoticed.
        realtimeCoordinator.start(authRepository)
        // US-1382: photos shared in from another app become a capture
        // session on the next foreground.
        intakeDrainer.observeForeground()
        // US-1379: half-hourly catch-up sync. Re-applied on every cold start,
        // which is also what re-arms it after a reboot — WorkManager restores
        // its own queue, and KEEP means this call is a no-op when it did.
        appScope.launch {
            BackgroundRefreshWorker.apply(
                this@GradeThreadApp,
                backgroundRefreshStore.enabled.first(),
            )
        }
    }

    /** Lives as long as the process — these observers never unsubscribe. */
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Inject
    lateinit var syncTrigger: SyncTrigger

    @Inject
    lateinit var authRepository: AuthRepository

    @Inject
    lateinit var subscriptions: SubscriptionService

    @Inject
    lateinit var pushRegistration: PushRegistration

    @Inject
    lateinit var backgroundRefreshStore: BackgroundRefreshStore

    @Inject
    lateinit var intakeDrainer: IntakeDrainer

    @Inject
    lateinit var realtimeCoordinator: RealtimeCoordinator
}
