package com.gradethread.app.marketplaces

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-2481: queue extension work from the phone, run it on the desktop.
 *
 * Poshmark, Mercari, Grailed, Vinted and Facebook Marketplace have no write
 * API, so GradeThread reaches them from the seller's own logged-in browser —
 * see `vault/60-decisions/adr-no-server-side-marketplace-automation.md`. The
 * cost that decision accepts is that a seller sourcing with only a phone cannot
 * cross-list, and a delist after a sale waits for the laptop.
 *
 * This softens it without paying the price the ADR refuses. The phone records
 * an INSTRUCTION — an item id, a platform, a locale key — and the desktop
 * extension drains it. What the server never records is a way in: no password,
 * no session cookie. The edge rejects a payload carrying one by key, and so
 * does a CHECK constraint on the table.
 *
 * THE ONE RULE FOR ANY UI BUILT ON THIS. A queued job is not a done job.
 * [QUEUED_NOTICE] is the sentence to show and it must not be softened into
 * something that reads like completion. For a delist especially: a seller who
 * believes it was handled is a seller heading for a double sale, where a second
 * buyer pays for an item they have already shipped.
 */
@Serializable
data class ExtensionQueueItem(
    val id: String,
    val kind: String,
    val platform: String,
    val status: String,
    val source: String = "mobile",
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
    val result: ExtensionQueueResult? = null,
)

@Serializable
data class ExtensionQueueResult(
    val error: String? = null,
    val manual: Boolean? = null,
    val expired: Boolean? = null,
)

@Serializable
data class ExtensionQueueSnapshot(
    val pending: List<ExtensionQueueItem> = emptyList(),
    /**
     * Work that expired undrained or failed when it ran. Separate from
     * [pending] on purpose — rendering it as "still coming" is exactly the
     * silence this queue would otherwise reintroduce (US-2481 AC6).
     */
    val needsAttention: List<ExtensionQueueItem> = emptyList(),
)

@Serializable
private data class EnqueueBody(
    val kind: String,
    val platform: String,
    @SerialName("inventory_item_id") val inventoryItemId: String? = null,
    @SerialName("listing_id") val listingId: String? = null,
    val payload: Map<String, String> = emptyMap(),
    val source: String = "android",
)

@Serializable
private data class EnqueueResponse(
    val queued: ExtensionQueueItem,
    val notice: String? = null,
)

@Serializable
private data class CancelResponse(val cancelled: String)

/** The three things the desktop extension can actually run. */
enum class ExtensionQueueKind(val wire: String) {
    LIST("list"),
    DELIST("delist"),
    SHARE("share"),
}

/**
 * The wording every client shows for queued work.
 *
 * Mirrors `QUEUED_NOTICE` in `src/hooks/use-extension-queue.ts`,
 * `ExtensionQueueService.queuedNotice` on iOS, and the edge's
 * `lib/extension-queue.ts` — one sentence across four surfaces, so no platform
 * can invent a cheerier version of it.
 */
const val QUEUED_NOTICE: String =
    "This runs the next time you open your desktop browser with the GradeThread " +
        "extension installed. Nothing happens on the marketplace until then."

@Singleton
class ExtensionQueueRepository @Inject constructor(
    private val edgeApi: EdgeApi,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private companion object {
        const val PATH = "/api/flipdesk/extension-queue"
    }

    /**
     * Queue one piece of extension work. The desktop does not have to be awake.
     *
     * [payload] is a plain string map by design: an instruction is an item id, a
     * platform and at most a locale key. Widening it is how a future caller ends
     * up stuffing something in here that the edge then has to refuse.
     */
    suspend fun enqueue(
        kind: ExtensionQueueKind,
        platform: String,
        inventoryItemId: String? = null,
        listingId: String? = null,
        payload: Map<String, String> = emptyMap(),
    ): ExtensionQueueItem {
        val body = json.encodeToString(
            EnqueueBody.serializer(),
            EnqueueBody(
                kind = kind.wire,
                platform = platform,
                inventoryItemId = inventoryItemId,
                listingId = listingId,
                payload = payload,
            ),
        )
        val raw = edgeApi.postRaw(PATH, body)
        return json.decodeFromString(EnqueueResponse.serializer(), raw).queued
    }

    /** What is still waiting, and what never ran. */
    suspend fun snapshot(): ExtensionQueueSnapshot {
        val raw = edgeApi.getRaw(PATH)
        return json.decodeFromString(ExtensionQueueSnapshot.serializer(), raw)
    }

    /** Remove a job the seller no longer wants run. */
    suspend fun cancel(id: String) {
        val raw = edgeApi.deleteRaw("$PATH/$id")
        json.decodeFromString(CancelResponse.serializer(), raw)
    }

}

/**
 * How a queued job reads in a list.
 *
 * A top-level function, not a repository method: the phrasing has nothing to do
 * with the network, and making it free of the repository is what lets a unit
 * test hold it without standing up an [EdgeApi]. Copy that only a UI can reach
 * is copy that only a human can check.
 */
fun describeQueuedWork(item: ExtensionQueueItem): String {
    val label = MARKETPLACE_LABELS[item.platform]
        ?: item.platform.replaceFirstChar { it.uppercase() }
    return when (item.kind) {
        "delist" -> "End the $label listing"
        "share" -> "Share your $label closet"
        else -> "List to $label"
    }
}

/**
 * Channel labels, mirroring `MARKETPLACE_LABELS` in `src/lib/constants.ts`.
 * Only the extension-mechanism channels appear here — an API channel never
 * produces a queue row, because the server can publish to it directly.
 */
private val MARKETPLACE_LABELS = mapOf(
    "poshmark" to "Poshmark",
    "mercari" to "Mercari",
    "grailed" to "Grailed",
    "vinted" to "Vinted",
    "facebook" to "Facebook Marketplace",
)
