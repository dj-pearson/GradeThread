package com.gradethread.app.platform.supabase

import android.content.Context
import android.content.SharedPreferences
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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

    private val prefs: SharedPreferences? = openStore(context)

    /**
     * Every read and write goes through the IO dispatcher.
     *
     * These are `suspend` functions, which is a promise that they are safe to
     * call from the main thread, and they were not: EncryptedSharedPreferences
     * does an AES pass and a file write inline, and supabase-kt calls
     * [saveSession] on every token refresh. A suspend function that blocks its
     * caller's thread is worse than a blocking one, because nothing at the call
     * site looks wrong.
     */
    override suspend fun saveSession(session: UserSession) {
        val store = prefs ?: return
        val encoded = json.encodeToString(UserSession.serializer(), session)
        // commit(), not apply(): apply() hands the write to a background thread
        // and returns, and we are already on one. On IO the two cost the same,
        // and commit() means a process death straight after a refresh cannot
        // lose the new token and strand the seller on the old one.
        withContext(Dispatchers.IO) { store.edit().putString(KEY, encoded).commit() }
    }

    override suspend fun loadSession(): UserSession? {
        val store = prefs ?: return null
        val raw = withContext(Dispatchers.IO) { store.getString(KEY, null) } ?: return null
        return runCatching { json.decodeFromString(UserSession.serializer(), raw) }.getOrNull()
    }

    override suspend fun deleteSession() {
        val store = prefs ?: return
        withContext(Dispatchers.IO) { store.edit().remove(KEY).commit() }
    }

    private companion object {
        const val KEY = "session"
        const val STORE = "gradethread.supabase.session.v1"

        /**
         * Open the encrypted store, and never throw.
         *
         * `EncryptedSharedPreferences.create` is not a safe call. It reads a
         * Keystore key and a Tink keyset header, and it raises when either is
         * unreadable: a backup restored onto different hardware, a Keystore
         * entry invalidated by a lock-screen change or an OS upgrade, a
         * half-written keyset. The reports are all the same shape -
         * `InvalidProtocolBufferException`, `KeyStoreException`,
         * `AEADBadTagException`, `GeneralSecurityException`.
         *
         * This runs inside `SupabaseShared.build()`, which Hilt evaluates while
         * `Application.onCreate` is still running. So an uncaught throw here is
         * not a failed sign-in - it is a crash on every launch, on a device
         * whose owner has done nothing wrong, clearable only by wiping the
         * app's data. That is the same failure `DatabaseProvider` carries a
         * recovery ladder for, and this is the same ladder:
         *
         *  1. open normally;
         *  2. the keyset is unreadable, so DELETE IT and open a fresh one. The
         *     only thing lost is a session, and a session is recoverable by
         *     signing in - which is what an unreadable one forces anyway;
         *  3. still failing: return null and run with no persistence. The app
         *     works for this launch and asks for a password on the next one.
         *
         * Step 2 is safe to do blind precisely BECAUSE the payload is a
         * session. Nothing here is the only copy of anything.
         */
        private fun openStore(context: Context): SharedPreferences? {
            create(context)?.let { return it }
            // One delete is enough: EncryptedSharedPreferences keeps its two Tink
            // keysets inside this same prefs file, under reserved keys, so the
            // keys and the ciphertext they no longer open go together. What it
            // does NOT remove is the Keystore master key, which is correct - if
            // THAT is the invalidated thing, the retry below fails too and step
            // 3 takes over.
            runCatching { context.deleteSharedPreferences(STORE) }
            return create(context)
        }

        private fun create(context: Context): SharedPreferences? = runCatching {
            EncryptedSharedPreferences.create(
                context,
                STORE,
                MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }.getOrNull()
    }
}

/** Convenience accessor mirroring `SupabaseShared.client.auth`. */
val SupabaseClient.authModule: Auth get() = auth
