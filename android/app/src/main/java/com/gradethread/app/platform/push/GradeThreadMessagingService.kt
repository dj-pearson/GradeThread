package com.gradethread.app.platform.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1378: the receive side.
 *
 * Both callbacks run on a background thread the framework owns and expects back
 * quickly, so the only work done inline is parsing and posting; the network
 * registration is launched on our own scope.
 */
@AndroidEntryPoint
class GradeThreadMessagingService : FirebaseMessagingService() {

    @Inject
    lateinit var registration: PushRegistration

    /** Service-scoped: a registration must outlive the callback returning. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * The token rotated, or arrived for the first time.
     *
     * Sent straight through rather than deferred to the next app launch: a
     * rotated token means the OLD one is dead, and every push between now and
     * that launch would go nowhere.
     */
    override fun onNewToken(token: String) {
        Telemetry.breadcrumb("fcm token rotated", "push")
        scope.launch { registration.register(token) }
    }

    override fun onMessageReceived(remote: RemoteMessage) {
        val message = PushMessage.of(
            data = remote.data,
            notificationTitle = remote.notification?.title,
            notificationBody = remote.notification?.body,
        )
        Telemetry.event(
            "push.received",
            mapOf("category" to (message.category?.id ?: "unknown")),
        )
        // Posted ourselves even when the payload carries a notification block:
        // the system's own rendering has no channel of ours, no deep link and
        // no action buttons on it.
        PushNotifier.show(applicationContext, message)
    }
}
