package com.gradethread.app.platform.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.gradethread.app.MainActivity
import com.gradethread.app.platform.telemetry.Telemetry

/**
 * US-1378: an inline button tap.
 *
 * A BroadcastReceiver runs on the MAIN thread with about ten seconds of grace,
 * which is nowhere near enough for a network call — so this only decides and
 * hands off. The work itself goes to a [PushActionWorker], which survives the
 * receiver returning and gets retried if the network is down.
 */
class PushActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val actionId = intent.getStringExtra(PushNotifier.EXTRA_ACTION) ?: return
        val notificationId = intent.getIntExtra(PushNotifier.EXTRA_NOTIFICATION_ID, 0)

        @Suppress("UNCHECKED_CAST")
        val data = (intent.getSerializableExtra(PushNotifier.EXTRA_DATA) as? HashMap<String, String>)
            ?.toMap()
            .orEmpty()

        val typed = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(PushNotifier.INPUT_KEY)
            ?.toString()

        val plan = PushActionPlan.of(actionId, data, typed)
        Telemetry.event(
            "push.action",
            mapOf("action" to actionId, "resolved" to plan::class.simpleName),
        )

        when (plan) {
            // These two need a person: OAuth needs a browser, and an
            // unresolvable action needs the screen it couldn't act on.
            is PushActionPlan.Reconnect ->
                openApp(context, "https://gradethread.com/app/reconnect")
            is PushActionPlan.Open -> openApp(context, plan.route.toDeepLinkUri())

            PushActionPlan.None -> return

            else -> {
                enqueue(context, actionId, data, typed)
                // Dismissed on HAND-OFF, not on success. The seller tapped it
                // and the work is durable; leaving the notification up would
                // invite a second tap and a duplicate action.
                NotificationManagerCompat.from(context).cancel(notificationId)
            }
        }
    }

    private fun openApp(context: Context, uri: String) {
        context.startActivity(
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                data = Uri.parse(uri)
            },
        )
    }

    private fun enqueue(
        context: Context,
        actionId: String,
        data: Map<String, String>,
        typed: String?,
    ) {
        val input = Data.Builder()
            .putString(PushActionWorker.KEY_ACTION, actionId)
            .putString(PushActionWorker.KEY_TEXT, typed)
            .apply { data.forEach { (k, v) -> putString(PushActionWorker.dataKey(k), v) } }
            .build()

        WorkManager.getInstance(context).enqueue(
            OneTimeWorkRequestBuilder<PushActionWorker>()
                .setInputData(input)
                .setConstraints(PushActionWorker.CONSTRAINTS)
                .build(),
        )
    }
}
