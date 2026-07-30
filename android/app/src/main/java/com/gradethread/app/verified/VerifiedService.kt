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
 * Read-only on purpose. Editing the handle, the bio and the public toggle
 * happens on the web; this surface exists so a seller can see where they stand
 * and what is left to do without going and looking for it.
 */
interface VerifiedProviding {
    suspend fun profile(): VerifiedProfileResponse

    /** The last successful read, or null. Survives a cold start. */
    suspend fun cached(): VerifiedProfileResponse?
}

@Singleton
class VerifiedService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
    private val store: VerifiedCache,
) : VerifiedProviding {

    companion object {
        const val PATH = "/api/verified/profile"
        private val json = Json { ignoreUnknownKeys = true }
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
