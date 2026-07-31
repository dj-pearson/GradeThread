package com.gradethread.app.platform.push

import android.content.Context
import android.os.Build
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.google.firebase.messaging.FirebaseMessaging
import com.gradethread.app.BuildConfig
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton
import kotlin.coroutines.resume

private val Context.pushDataStore by preferencesDataStore(name = "push_token")

@Serializable
private data class RegisterRequest(
    @SerialName("device_token") val deviceToken: String,
    val platform: String = "fcm",
    @SerialName("device_name") val deviceName: String? = null,
    @SerialName("os_version") val osVersion: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
)

/**
 * US-1378: telling the server where to send.
 *
 * The token goes to `POST /api/notifications/register` with `platform=fcm`. The
 * route is idempotent on (user, token), so re-registering the same one just
 * bumps `last_seen_at` — which is why this runs on every cold start rather than
 * only when the token rotates: a token can be revoked server-side by a prune
 * job, and a client that only registers on change would never come back.
 */
@Singleton
class PushRegistration @Inject constructor(
    @ApplicationContext private val context: Context,
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        const val REGISTER_PATH = "/api/notifications/register"
        /** Same path, DELETE — the token rides in the body, not the URL. */
        const val UNREGISTER_PATH = "/api/notifications/register"
        private val TOKEN_KEY = stringPreferencesKey("fcm_token")
        private val json = Json { encodeDefaults = true }
    }

    /** The current token, or null when push isn't configured or Play is absent. */
    suspend fun currentToken(): String? {
        if (!PushConfig.initialize(context)) return null
        return runCatching {
            suspendCancellableCoroutine { continuation ->
                FirebaseMessaging.getInstance().token
                    .addOnSuccessListener { continuation.resume(it) }
                    // A device with no Play Services can't have a token. That is
                    // a fact about the device, not a failure to report.
                    .addOnFailureListener { continuation.resume(null) }
            }
        }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    /** Register whatever token we have. Silent on failure — push is optional. */
    suspend fun register(token: String? = null) {
        val deviceToken = token ?: currentToken() ?: return
        runCatching {
            edge.postRaw(
                REGISTER_PATH,
                json.encodeToString(
                    RegisterRequest.serializer(),
                    RegisterRequest(
                        deviceToken = deviceToken,
                        deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
                        osVersion = "Android ${Build.VERSION.RELEASE}",
                        appVersion = BuildConfig.VERSION_NAME,
                    ),
                ),
            )
            remember(deviceToken)
        }.onFailure {
            // Not surfaced: a seller who can't register still has a working app,
            // and an error banner about a background registration is noise they
            // can do nothing about.
            Telemetry.breadcrumb("push register failed: ${it.message}", "push")
        }
    }

    /**
     * Sign-out: drop the token locally AND tell the server to stop sending.
     *
     * The local delete alone is not enough — the server would keep pushing this
     * account's sales to a phone somebody else may now be holding.
     */
    suspend fun clear() {
        val token = stored()
        if (token != null) {
            runCatching {
                edge.deleteRaw(UNREGISTER_PATH, """{"device_token":"$token"}""")
            }.onFailure {
                Telemetry.breadcrumb("push unregister failed: ${it.message}", "push")
            }
        }
        // Deleted regardless of whether the server call worked: the next
        // sign-in registers a fresh token anyway, and keeping a stale one only
        // risks re-registering it under the wrong account.
        runCatching { FirebaseMessaging.getInstance().deleteToken() }
        context.pushDataStore.edit { it.remove(TOKEN_KEY) }
    }

    private suspend fun stored(): String? =
        context.pushDataStore.data.map { it[TOKEN_KEY] }.first()

    private suspend fun remember(token: String) {
        context.pushDataStore.edit { it[TOKEN_KEY] = token }
    }
}
