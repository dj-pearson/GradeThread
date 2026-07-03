package com.gradethread.app.platform.supabase

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.gradethread.app.platform.AppConfig
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.auth.FlowType
import io.github.jan.supabase.auth.SessionManager
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.user.UserSession
import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.postgrest.Postgrest
import io.github.jan.supabase.realtime.Realtime
import io.github.jan.supabase.storage.Storage
import kotlinx.serialization.json.Json
import kotlin.time.Duration.Companion.seconds

/**
 * US-1307: the single shared Supabase client (iOS SupabaseShared) — auth,
 * PostgREST, Realtime, and Storage all reach the self-hosted stack
 * (api.gradethread.com) through this one instance. PKCE flow; the session is
 * persisted in EncryptedSharedPreferences (Keystore-backed, device-only —
 * mirroring the iOS Keychain accessibility class); HTTP is bounded so a
 * stalled auth/DB call fails fast instead of hanging a spinner (the same 30s
 * the iOS bounded session settled on after the 1h-refresh incident).
 */
object SupabaseShared {

    @Volatile
    private var instance: SupabaseClient? = null

    fun client(context: Context): SupabaseClient =
        instance ?: synchronized(this) {
            instance ?: build(context.applicationContext).also { instance = it }
        }

    private fun build(context: Context): SupabaseClient =
        createSupabaseClient(
            supabaseUrl = AppConfig.supabaseUrl,
            supabaseKey = AppConfig.supabaseAnonKey,
        ) {
            requestTimeout = 30.seconds
            defaultSerializer = io.github.jan.supabase.serializer.KotlinXSerializer(
                Json { ignoreUnknownKeys = true },
            )
            install(Auth) {
                flowType = FlowType.PKCE
                sessionManager = EncryptedSessionManager(context)
            }
            install(Postgrest)
            install(Realtime)
            install(Storage)
        }
}

/**
 * US-1307: Keystore-backed session persistence (the KeychainLocalStorage
 * analog). EncryptedSharedPreferences keys never leave the device's Keystore
 * (no backup restore onto another device), matching the iOS
 * "AfterFirstUnlockThisDeviceOnly" accessibility. Namespaced file so a future
 * multi-account world can add suffixed stores.
 */
class EncryptedSessionManager(context: Context) : SessionManager {

    private val json = Json { ignoreUnknownKeys = true }

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "gradethread.supabase.session.v1",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override suspend fun saveSession(session: UserSession) {
        prefs.edit().putString(KEY, json.encodeToString(UserSession.serializer(), session)).apply()
    }

    override suspend fun loadSession(): UserSession? =
        prefs.getString(KEY, null)?.let { raw ->
            runCatching { json.decodeFromString(UserSession.serializer(), raw) }.getOrNull()
        }

    override suspend fun deleteSession() {
        prefs.edit().remove(KEY).apply()
    }

    private companion object {
        const val KEY = "session"
    }
}

/** Convenience accessor mirroring `SupabaseShared.client.auth`. */
val SupabaseClient.authModule: Auth get() = auth
