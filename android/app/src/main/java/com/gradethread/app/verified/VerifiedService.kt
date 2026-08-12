package com.gradethread.app.verified

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.gradethread.app.platform.net.EdgeApi
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

private val Context.verifiedDataStore by preferencesDataStore(name = "verified_profile")

/**
 * US-1375: the seller's own verification status.
 *
 * US-2493: no longer read-only. It was, and the reason given was that editing
 * "happens on the web" — but a seller who signs up on their phone then has a
 * badge screen that can only ever tell them to go and find a computer to claim
 * a handle, which is the first step of four. iOS has had the write since
 * US-1375; this closes the gap the US-1299 parity audit found.
 */
interface VerifiedProviding {
    suspend fun profile(): VerifiedProfileResponse

    /** The last successful read, or null. Survives a cold start. */
    suspend fun cached(): VerifiedProfileResponse?

    /**
     * Write the fields that are present. A null field is NOT sent, so it is
     * left alone — see [VerifiedProfileUpdate].
     */
    suspend fun update(update: VerifiedProfileUpdate): VerifiedProfileResponse

    /**
     * Is this handle free? Asked BEFORE the save (US-2493 AC2), because a
     * rejection that arrives after the seller has committed is a rejection
     * they have to undo.
     */
    suspend fun handleAvailable(handle: String): HandleAvailability
}

@Singleton
class VerifiedService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
    private val store: VerifiedCache,
) : VerifiedProviding {

    companion object {
        const val PATH = "/api/verified/profile"
        const val HANDLE_PATH = "/api/verified/handle-available"
        private val json = Json { ignoreUnknownKeys = true }

        /**
         * encodeDefaults is OFF, and that is load-bearing. Every field of
         * [VerifiedProfileUpdate] defaults to null, and the edge reads
         * present-and-null as "clear it" — so encoding defaults would send the
         * whole object on every save and wipe the bio of anyone who only
         * toggled their profile public.
         */
        private val writeJson = Json { encodeDefaults = false; explicitNulls = false }
    }

    override suspend fun profile(): VerifiedProfileResponse {
        val response = json.decodeFromString(
            VerifiedProfileResponse.serializer(),
            edge.getRaw(PATH),
        )
        // Cached AFTER a successful decode, never before: writing a payload we
        // couldn't read would poison the offline state with something that
        // fails the same way every cold start.
        store.save(response)
        return response
    }

    override suspend fun cached(): VerifiedProfileResponse? = store.load()

    override suspend fun update(update: VerifiedProfileUpdate): VerifiedProfileResponse {
        val body = writeJson.encodeToString(VerifiedProfileUpdate.serializer(), update)
        edge.putRaw(PATH, body)
        // The PUT returns the updated columns but not the stats, so the read is
        // re-issued rather than patched locally. One shape, one decode path,
        // and the cache is written by the same code that always wrote it.
        return profile()
    }

    override suspend fun handleAvailable(handle: String): HandleAvailability {
        val raw = edge.getRaw(
            HANDLE_PATH,
            query = mapOf("handle" to VerifiedHandleRules.normalize(handle)),
        )
        return json.decodeFromString(HandleAvailability.serializer(), raw)
    }
}

/**
 * The last-known status, on disk.
 *
 * This is what "degrades gracefully offline" means here: rather than an empty
 * screen with a network error on it, the seller sees where they stood last time
 * and a plain note that it may have moved on.
 */
@Singleton
class VerifiedCache @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun save(response: VerifiedProfileResponse) {
        val encoded = json.encodeToString(VerifiedProfileResponse.serializer(), response)
        context.verifiedDataStore.edit { it[KEY] = encoded }
    }

    suspend fun load(): VerifiedProfileResponse? {
        val raw = context.verifiedDataStore.data.map { it[KEY] }.first() ?: return null
        // A cache we can't read is a cache we don't have. Throwing here would
        // turn a stale format into a crash on a screen that is meant to be the
        // calm one.
        return runCatching {
            json.decodeFromString(VerifiedProfileResponse.serializer(), raw)
        }.getOrNull()
    }

    suspend fun clear() {
        context.verifiedDataStore.edit { it.remove(KEY) }
    }

    private companion object {
        val KEY = stringPreferencesKey("last_profile_json")
    }
}
