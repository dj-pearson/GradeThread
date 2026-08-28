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
    /**
     * Register the channels, and keep their names in the reader's language.
     *
     * The importance and the DND bypass are applied ONLY on first creation.
     * That was already the rule, and it is the right one: the system ignores an
     * importance change after creation, and a seller who turned Payouts down to
     * silent should not have the app turn it back up.
     *
     * The name and the description are re-applied EVERY time, which is new and
     * is what makes the resources above worth anything. Android stores a
     * channel's name as the literal text it was given, so a channel created
     * while the phone was in English keeps its English name forever - through a
     * system language change, and through the app's own per-app language
     * setting. Re-passing them is the documented way to update a channel, and
     * it is the narrow one: name, description and group are the only fields a
     * second `createNotificationChannel` can change, and none of them is
     * something the seller can have tuned.
     */
    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        PushChannel.entries.forEach { channel ->
            val existing = manager.getNotificationChannel(channel.id)
            val importance = existing?.importance ?: channel.importance
            manager.createNotificationChannel(
                NotificationChannel(
                    channel.id,
                    context.getString(channel.titleRes),
                    importance,
                ).apply {
                    description = context.getString(channel.descriptionRes)
                    if (existing == null) setBypassDnd(channel.bypassDnd)
                },
            )
        }
    }

    /** A stable id per collapse tag, so a second payout push replaces the first. */
    fun notificationId(message: PushMessage): Int =
        (message.tag ?: message.category?.id ?: message.title).hashCode().absoluteValue

    // US-2435: lint's MissingPermission cannot see through the `runCatching`
    // lambda at the end of this function, so it reports the notify() call as
    // unhandled. It is handled — SecurityException is exactly what that wrapper
    // is there to swallow, and the comment at the call site has said so since
    // the code was written.
    //
    // Suppressed rather than "fixed" with a checkSelfPermission call, because a
    // pre-flight check would be WORSE here: permission can be revoked between
    // the check and the notify, so the catch would still be required and the
    // check would only add a race and a second thing to keep in sync. The
    // annotation is on `show` rather than the file so a genuinely unhandled
    // permission call added elsewhere in this class still fails the build.
    @android.annotation.SuppressLint("MissingPermission")
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
