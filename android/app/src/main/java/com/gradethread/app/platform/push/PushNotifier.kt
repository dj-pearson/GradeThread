package com.gradethread.app.platform.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import com.gradethread.app.MainActivity
import com.gradethread.app.R
import kotlin.math.absoluteValue

/**
 * US-1378: turning a parsed push into something on the lock screen.
 *
 * All the judgement lives in [PushCategory] and [PushMessage]; this only builds
 * the framework objects.
 */
object PushNotifier {

    /** The typed-reply key an inline action's text comes back under. */
    const val INPUT_KEY = "push_action_text"

    /** Extras the action receiver reads. */
    const val EXTRA_ACTION = "push_action_id"
    const val EXTRA_DATA = "push_data"
    const val EXTRA_NOTIFICATION_ID = "push_notification_id"

    /**
     * Create every channel.
     *
     * Called on cold start, not lazily on the first push: a seller who opens
     * system settings before their first notification should still see what the
     * app can send and be able to tune it in advance.
     */
    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        PushChannel.entries.forEach { channel ->
            val existing = manager.getNotificationChannel(channel.id)
            // Never recreate an existing channel: the system ignores importance
            // changes after creation anyway, and re-registering would undo any
            // tuning the seller has done to it.
            if (existing != null) return@forEach
            manager.createNotificationChannel(
                NotificationChannel(channel.id, channel.title, channel.importance).apply {
                    description = channel.description
                    setBypassDnd(channel.bypassDnd)
                },
            )
        }
    }

    /** A stable id per collapse tag, so a second payout push replaces the first. */
    fun notificationId(message: PushMessage): Int =
        (message.tag ?: message.category?.id ?: message.title).hashCode().absoluteValue

    fun show(context: Context, message: PushMessage) {
        if (!message.renderable) return
        createChannels(context)

        val id = notificationId(message)
        val builder = NotificationCompat.Builder(context, message.channel.id)
            // US-1381: the silhouette, not the launcher icon. Android masks
            // every small icon to white, so a full-colour one is a blob.
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(message.title.ifBlank { message.body })
            .setContentText(message.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message.body))
            .setAutoCancel(true)
            .setContentIntent(tapIntent(context, message, id))

        message.tag?.let { builder.setGroup(it) }
        if (message.channel == PushChannel.URGENT) {
            builder.setPriority(NotificationCompat.PRIORITY_HIGH)
            // Category ERROR is what asks the system to treat this as
            // time-sensitive; without it the DND bypass on the channel has
            // nothing to act on.
            builder.setCategory(NotificationCompat.CATEGORY_ERROR)
        }

        message.actions.forEach { action ->
            builder.addAction(actionButton(context, message, action, id))
        }

        runCatching {
            // Wrapped: posting without POST_NOTIFICATIONS throws on API 33+,
            // and a push arriving before the seller has granted it must not
            // take the process down.
            NotificationManagerCompat.from(context).notify(id, builder.build())
        }
    }

    /**
     * Where a tap goes.
     *
     * Through the deep-link Uri the app already handles, rather than a bespoke
     * extra: one routing table, and the same link works from a push, a widget
     * and an email.
     */
    private fun tapIntent(context: Context, message: PushMessage, id: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            message.route?.let { data = Uri.parse(it.toDeepLinkUri()) }
        }
        return PendingIntent.getActivity(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionButton(
        context: Context,
        message: PushMessage,
        action: PushAction,
        notificationId: Int,
    ): NotificationCompat.Action {
        val intent = Intent(context, PushActionReceiver::class.java).apply {
            putExtra(EXTRA_ACTION, action.id)
            putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            putExtra(EXTRA_DATA, HashMap(message.data))
        }
        val pending = PendingIntent.getBroadcast(
            context,
            (notificationId.toString() + action.id).hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or
                // MUTABLE is required for a typed reply — the system writes the
                // text into the intent. Plain taps stay immutable.
                if (action.takesInput) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Action.Builder(0, action.title, pending)
        action.inputPlaceholder?.let { placeholder ->
            builder.addRemoteInput(
                RemoteInput.Builder(INPUT_KEY).setLabel(placeholder).build(),
            )
        }
        return builder.build()
    }
}
