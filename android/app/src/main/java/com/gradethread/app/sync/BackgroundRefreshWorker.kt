package com.gradethread.app.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.gradethread.app.platform.push.PushMessage
import com.gradethread.app.platform.push.PushNotifier
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.flow.first
import java.util.concurrent.TimeUnit

/**
 * US-1379: the app catching up while nobody is looking.
 *
 * Runs a normal sync pull, then compares what arrived against the stored
 * baseline and posts a local notification for anything new. Everything it
 * decides lives in [BackgroundRefresh], so the part that runs unobserved is
 * also the part that is unit-tested.
 */
class BackgroundRefreshWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun syncTrigger(): SyncTrigger
        fun db(): GradeThreadDb
        fun store(): BackgroundRefreshStore
    }

    override suspend fun doWork(): Result {
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        val store = deps.store()

        // Checked here as well as at schedule time: a toggle flipped while a
        // run was already queued must not fire it.
        if (!store.enabledNow()) return Result.success()

        val outcome = runCatching { deps.syncTrigger().refresh(reason = "background") }.getOrElse { error ->
            Telemetry.breadcrumb("background refresh failed: ${error.message}", "sync")
            // Retried rather than failed: the next window is half an hour away,
            // and a transient blip shouldn't cost the seller a sale alert for
            // that long.
            return Result.retry()
        }
        // Null means signed out. Not an error, and nothing to notify about.
            ?: return Result.success()

        if (!outcome.succeeded) {
            // A partial pull may be missing the very rows we would notify on.
            // Comparing against it would write a baseline that swallows them.
            Telemetry.breadcrumb("background refresh partial; skipping notify", "sync")
            return Result.retry()
        }

        notifyAndRebaseline(deps, store)
        return Result.success()
    }

    private suspend fun notifyAndRebaseline(deps: Deps, store: BackgroundRefreshStore) {
        val sales = deps.db().sales().all()
        val items = deps.db().items().observeAll().first()

        val findings = BackgroundRefresh.findings(
            sales = sales,
            items = items,
            seenSaleIds = store.seenSaleIds(),
            seenGradedItemIds = store.seenGradedItemIds(),
            baselineEstablished = store.baselineEstablished(),
        )

        BackgroundRefresh.notices(findings).forEach { notice ->
            PushNotifier.show(applicationContext, notice.toPushMessage())
        }
        if (!findings.isEmpty) {
            Telemetry.event(
                "background_refresh.notified",
                mapOf("sales" to findings.newSales.size, "grades" to findings.newlyGraded.size),
            )
        }

        // Written AFTER posting, so a crash between the two re-notifies rather
        // than silently swallowing. A duplicate notification is a nuisance; a
        // missed sale alert is the thing this feature exists to prevent.
        val (saleIds, gradedIds) = BackgroundRefresh.baseline(sales, items)
        store.writeBaseline(saleIds, gradedIds)
    }

    companion object {
        const val WORK_NAME = "background-refresh"

        /**
         * Half an hour, with a ten-minute flex window.
         *
         * WorkManager's own floor is 15 minutes and it batches work across apps
         * anyway; the flex lets it ride along with whatever else the system was
         * already waking for, which is most of the battery saving here.
         */
        val INTERVAL_MINUTES = 30L
        val FLEX_MINUTES = 10L

        val CONSTRAINTS: Constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            // Not on a dying battery. A sale alert is not worth the last 5%,
            // and the foreground sync will catch it the moment they open the app.
            .setRequiresBatteryNotLow(true)
            .build()

        /**
         * Schedule it, or cancel it.
         *
         * KEEP rather than REPLACE: called on every cold start, and REPLACE
         * would reset the period each launch so a seller who opens the app often
         * would never actually reach a run. WorkManager persists the request
         * across reboots itself, so this doubles as the reboot rescheduler.
         */
        fun apply(context: Context, enabled: Boolean) {
            val manager = WorkManager.getInstance(context)
            if (!enabled) {
                manager.cancelUniqueWork(WORK_NAME)
                return
            }
            manager.enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<BackgroundRefreshWorker>(
                    INTERVAL_MINUTES, TimeUnit.MINUTES,
                    FLEX_MINUTES, TimeUnit.MINUTES,
                )
                    .setConstraints(CONSTRAINTS)
                    .build(),
            )
        }
    }
}

/** Reuses the push rendering, so a local alert looks like a remote one. */
private fun BackgroundRefresh.Notice.toPushMessage(): PushMessage = PushMessage(
    // No server category: this is a locally-detected event, and claiming one
    // would route it through rules meant for a payload we didn't receive.
    category = null,
    title = title,
    body = body,
    data = itemId?.let { mapOf("inventory_item_id" to it) }.orEmpty(),
    tag = id,
)

private suspend fun BackgroundRefreshStore.enabledNow(): Boolean = enabled.first()
