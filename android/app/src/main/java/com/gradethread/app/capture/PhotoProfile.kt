package com.gradethread.app.capture

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * US-1326: per-category photo roles, server-authoritative
 * (services/edge-functions/src/lib/photo-profiles.ts; iOS PhotoProfile). A
 * watch gets watch-shaped slots instead of clothing defaults. Fetched from
 * `GET /api/flipdesk/photo-profiles` (1h TTL via EdgeApi's cache); the small
 * bundled fallback keeps capture working offline / on fetch failure.
 */
@Serializable
data class PhotoRole(
    /** Server photo_type string. */
    val type: String,
    val label: String,
    val hint: String,
    val required: Boolean,
    val icon: String,
)

@Serializable
data class PhotoProfile(
    val category: String,
    val label: String,
    /** Ordered — display order in the strip. */
    val roles: List<PhotoRole>,
) {

    /** Required roles resolved to capture slots (unknown types dropped). */
    val requiredSlots: List<PhotoSlotType>
        get() = roles.filter { it.required }.mapNotNull { PhotoSlotType.fromWire(it.type) }

    /**
     * Optional, NON-DEFECT roles resolved to slots. Defects keep their own
     * reveal-one-at-a-time mechanism in the capture flow (category-agnostic
     * by design, AC3) — they are excluded here.
     */
    val optionalSlots: List<PhotoSlotType>
        get() = roles
            .filter { !it.required && it.type != "defect" }
            .mapNotNull { PhotoSlotType.fromWire(it.type) }

    /** Whether this category offers defect close-ups at all. */
    val allowsDefects: Boolean
        get() = roles.any { it.type == "defect" }

    fun roleForServerType(serverType: String): PhotoRole? =
        roles.firstOrNull { it.type == serverType }

    companion object {
        val clothingFallback = PhotoProfile(
            category = "clothing",
            label = "Clothing",
            roles = listOf(
                PhotoRole("front", "Front", "Lay flat, full front in frame", required = true, icon = "shirt"),
                PhotoRole("back", "Back", "Same crop as the front shot", required = true, icon = "shirt"),
                PhotoRole("tag", "Garment Tag", "Care + size label, close enough to read", required = true, icon = "tag"),
                PhotoRole("detail", "Detail", "Texture, weave, or a distinctive feature", required = true, icon = "search"),
                PhotoRole("defect", "Defect", "Tight crop on any flaw — be honest", required = false, icon = "alert-triangle"),
            ),
        )

        val genericFallback = PhotoProfile(
            category = "other",
            label = "Other",
            roles = listOf(
                PhotoRole("front", "Front", "Main view in frame", required = true, icon = "image"),
                PhotoRole("back", "Back", "Reverse view", required = true, icon = "image"),
                PhotoRole("detail", "Detail", "Distinguishing detail or label", required = false, icon = "search"),
                PhotoRole("defect", "Defect", "Tight crop on any flaw — be honest", required = false, icon = "alert-triangle"),
            ),
        )

        val bundledFallback: Map<String, PhotoProfile> = mapOf(
            "clothing" to clothingFallback,
            "other" to genericFallback,
        )
    }
}

/**
 * Fetches + caches the profile table; a single fetch per session (the edge
 * caches server-side too). Bundled profiles guarantee callers can ALWAYS
 * resolve a profile — a fetch failure is non-fatal and retries next session.
 */
class PhotoProfileStore(private val api: EdgeApi) {

    @Serializable
    internal data class Wrapper(val profiles: Map<String, PhotoProfile>)

    @Volatile
    private var profiles: Map<String, PhotoProfile> = PhotoProfile.bundledFallback

    @Volatile
    private var loaded = false

    private val json = Json { ignoreUnknownKeys = true }

    /** Clothing is the historical default for null/unknown categories. */
    fun profileFor(category: String?): PhotoProfile {
        category?.let { profiles[it] }?.let { return it }
        return profiles["clothing"] ?: PhotoProfile.clothingFallback
    }

    /** Load once from the edge (1h TTL cache); safe to call repeatedly. */
    suspend fun loadIfNeeded() {
        if (loaded) return
        runCatching {
            val body = api.getRaw("/api/flipdesk/photo-profiles", cacheTtlMillis = 3_600_000)
            val wrapper = json.decodeFromString(Wrapper.serializer(), body)
            if (wrapper.profiles.isNotEmpty()) {
                profiles = wrapper.profiles
                loaded = true
            }
        } // failure keeps the bundled fallback — retry next session
    }

    /** Test seam. */
    internal fun installForTest(table: Map<String, PhotoProfile>) {
        profiles = table
        loaded = true
    }
}
