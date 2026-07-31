package com.gradethread.app.platform.push

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.WorkerParameters
import com.gradethread.app.fulfillment.FulfillmentOrder
import com.gradethread.app.fulfillment.FulfillmentService
import com.gradethread.app.marketplaces.negotiation.NegotiationService
import com.gradethread.app.marketplaces.negotiation.OfferAction
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent

/**
 * US-1378: an inline action, actually done.
 *
 * A worker rather than the receiver itself, for two reasons that both matter
 * here: a BroadcastReceiver gets about ten seconds on the main thread, which is
 * not enough for a round trip; and accepting an offer from a lock screen with
 * one bar of signal must not be lost because the request happened to fail. The
 * work is durable and retried.
 */
class PushActionWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun negotiation(): NegotiationService
        fun fulfillment(): FulfillmentService
        fun db(): GradeThreadDb
    }

    override suspend fun doWork(): Result {
        val actionId = inputData.getString(KEY_ACTION) ?: return Result.failure()
        val text = inputData.getString(KEY_TEXT)
        val data = inputData.keyValueMap
            .filterKeys { it.startsWith(DATA_PREFIX) }
            .mapNotNull { (key, value) ->
                (value as? String)?.let { key.removePrefix(DATA_PREFIX) to it }
            }
            .toMap()

        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)

        return when (val plan = PushActionPlan.of(actionId, data, text)) {
            is PushActionPlan.AcceptOffer -> run(deps, plan)
            is PushActionPlan.CounterOffer -> run(deps, plan)
            is PushActionPlan.MarkShipped -> run(deps, plan)
            // Resolved to something the receiver already handled by opening the
            // app. Nothing left to do here.
            else -> Result.success()
        }
    }

    private suspend fun run(deps: Deps, plan: PushActionPlan.AcceptOffer): Result =
        attempt("offer.accept") {
            deps.negotiation().respond(plan.bestOfferId, plan.itemId, OfferAction.ACCEPT)
        }

    private suspend fun run(deps: Deps, plan: PushActionPlan.CounterOffer): Result =
        attempt("offer.counter") {
            deps.negotiation().respond(
                bestOfferId = plan.bestOfferId,
                itemId = plan.itemId,
                action = OfferAction.COUNTER,
                counterPrice = plan.price,
            )
        }

    private suspend fun run(deps: Deps, plan: PushActionPlan.MarkShipped): Result =
        attempt("order.mark_shipped") {
            val sale = deps.db().sales().all().firstOrNull { it.id == plan.saleId }
                // The sale isn't on this device. Retrying won't conjure it, and
                // the seller can mark it in the queue once it syncs.
                ?: return@attempt
            deps.fulfillment().markShipped(
                FulfillmentOrder(sale, itemTitle = null),
                plan.tracking.orEmpty(),
            )
        }

    /**
     * Run it, and decide whether a failure is worth another go.
     *
     * Retried on anything transient, because the whole point of doing this in a
     * worker is that a lock-screen tap in bad signal still lands. A retry is
     * safe: accept and counter are keyed on the offer id server-side, and
     * mark-shipped is idempotent by design.
     */
    private suspend fun attempt(name: String, block: suspend () -> Unit): Result = try {
        block()
        Telemetry.event("push.action_done", mapOf("action" to name))
        Result.success()
    } catch (error: Throwable) {
        Telemetry.breadcrumb("push action $name failed: ${error.message}", "push")
        if (runAttemptCount >= MAX_ATTEMPTS) Result.failure() else Result.retry()
    }

    companion object {
        const val KEY_ACTION = "action"
        const val KEY_TEXT = "text"
        private const val DATA_PREFIX = "d_"

        /** Bounded: an action nobody can complete shouldn't retry forever. */
        const val MAX_ATTEMPTS = 4

        fun dataKey(name: String): String = DATA_PREFIX + name

        val CONSTRAINTS: Constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
    }
}
