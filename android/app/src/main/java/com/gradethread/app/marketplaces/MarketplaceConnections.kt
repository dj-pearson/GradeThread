package com.gradethread.app.marketplaces

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * One connected marketplace account.
 *
 * The token columns are NOT modelled. They are encrypted and server-only, and
 * a client type that named them would invite a select that pulls them onto the
 * device for no reason.
 */
@Serializable
data class MarketplaceConnection(
    val id: String = "",
    val marketplace: String = "",
    @SerialName("account_handle") val accountHandle: String? = null,
    val label: String? = null,
    @SerialName("is_primary") val isPrimary: Boolean = false,
    @SerialName("is_active") val isActive: Boolean = true,
    @SerialName("last_synced_at") val lastSyncedAt: String? = null,
    @SerialName("refresh_error") val refreshError: String? = null,
) {
    /** What to show: the seller's label, else the eBay handle, else a fallback. */
    val displayName: String
        get() = label?.takeIf { it.isNotBlank() }
            ?: accountHandle?.takeIf { it.isNotBlank() }
            ?: "eBay account"

    /** A connection whose refresh is failing still exists but can't be used. */
    val needsReconnect: Boolean get() = !refreshError.isNullOrBlank()
}

@Serializable
private data class ConsentResponse(@SerialName("consent_url") val consentUrl: String = "")

/**
 * US-1350: connecting, listing and disconnecting eBay accounts.
 *
 * Reads go through the ANON client so RLS scopes them to the owner; the
 * consent start and the disconnect go through the EDGE, because both touch
 * server-only material (the OAuth state row, the encrypted tokens).
 */
@Singleton
class MarketplaceConnectionRepository @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
    private val client: SupabaseClient,
) {

    companion object {
        const val START_PATH = "/api/flipdesk/ebay/oauth/start"
        const val DISCONNECT_PATH = "/api/flipdesk/ebay/disconnect"
        private const val TABLE = "marketplace_connections"
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Fetch the consent URL for a fresh attempt. */
    suspend fun startConsent(redirectPath: String): Result<String> = runCatching {
        val raw = edge.getRaw(START_PATH, mapOf("redirect_to" to redirectPath))
        val consent = json.decodeFromString(ConsentResponse.serializer(), raw).consentUrl
        if (consent.isBlank()) error("eBay didn't return a sign-in link.")
        consent
    }

    suspend fun list(): List<MarketplaceConnection> = runCatching {
        client.from(TABLE).select {
            filter {
                eq("marketplace", "ebay")
                eq("is_active", true)
            }
        }.decodeList<MarketplaceConnection>()
            // Primary first, then by name, so the list order matches the
            // precedence the edge's token resolver actually uses.
            .sortedWith(compareByDescending<MarketplaceConnection> { it.isPrimary }
                .thenBy { it.displayName.lowercase() })
    }.getOrDefault(emptyList())

    suspend fun rename(connectionId: String, label: String): Result<Unit> = runCatching {
        client.from(TABLE).update(
            JsonObject(
                mapOf(
                    "label" to (
                        label.trim().takeIf { it.isNotEmpty() }
                            ?.let { JsonPrimitive(it) }
                            // Cleared back to blank: fall back to the eBay
                            // handle rather than storing an empty label that
                            // renders as a nameless row.
                            ?: kotlinx.serialization.json.JsonNull
                        ),
                ),
            ),
        ) {
            filter { eq("id", connectionId) }
        }
        Unit
    }

    /**
     * Make one connection primary.
     *
     * Demotes the others FIRST. A partial-unique index enforces one primary
     * per marketplace, so promoting before demoting collides and the seller
     * is told their rename failed when nothing was wrong with it.
     */
    suspend fun setPrimary(connectionId: String): Result<Unit> = runCatching {
        client.from(TABLE).update(JsonObject(mapOf("is_primary" to JsonPrimitive(false)))) {
            filter {
                eq("marketplace", "ebay")
                eq("is_primary", true)
            }
        }
        client.from(TABLE).update(JsonObject(mapOf("is_primary" to JsonPrimitive(true)))) {
            filter { eq("id", connectionId) }
        }
        Unit
    }

    /**
     * Disconnect through the EDGE, never by flipping is_active locally: the
     * edge revokes the refresh token upstream and scrubs the encrypted
     * columns. A local-only deactivate would leave live eBay tokens sitting in
     * the database for an account the seller believes they disconnected.
     */
    suspend fun disconnect(connectionId: String?): Result<Unit> = runCatching {
        val body = connectionId?.let { """{"connection_id":"$it"}""" } ?: "{}"
        edge.postRaw(DISCONNECT_PATH, body)
        Unit
    }

    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Something went wrong with that eBay connection."
}
