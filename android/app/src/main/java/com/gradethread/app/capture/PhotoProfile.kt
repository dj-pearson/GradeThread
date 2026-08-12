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
    /**
     * US-2469 (migration 00587): the `item_photos.photo_role` qualifier this
     * slot writes, or null for a slot that takes none. Slot identity is
     * (type, role) — that is what lets a suit hold three separate `tag` slots
     * instead of needing a `tag_2` and a `tag_3` in the enum.
     *
     * Defaulted so a profile served by an older edge still decodes, and so the
     * bundled fallbacks below stay readable.
     */
    val role: String? = null,
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

    /**
     * US-2469: the role definition for a stored (type, role) PAIR. Prefer this
     * over [roleForServerType] whenever the caller has both halves — a suit
     * profile has three `tag` slots and the type alone picks the wrong one two
     * times out of three.
     */
    fun roleFor(serverType: String, photoRole: String?): PhotoRole? =
        roles.firstOrNull { it.type == serverType && it.role == photoRole }
            ?: roles.firstOrNull { it.type == serverType && it.role == null }

    companion object {
        /** Stable identity for a slot: "type" or "type:role". */
        fun slotKey(type: String, role: String?): String =
            if (role.isNullOrEmpty()) type else "$type:$role"

        /** Splits a [slotKey] back into its halves. */
        fun parseSlotKey(slot: String): Pair<String, String?> {
            val i = slot.indexOf(':')
            return if (i == -1) slot to null else slot.substring(0, i) to slot.substring(i + 1)
        }

        /**
         * US-2498: the bundled copy of the SERVER's clothing profile, role for
         * role and in the same order — the mirror of
         * `ios/GradeThread/Capture/PhotoProfile.swift` and of the `clothing`
         * entry in `src/lib/photo-profiles.ts`.
         *
         * It was five unroled slots, which mattered once the capture strip
         * started reading from here: a seller who opened the camera offline was
         * offered front, back, one nameless tag and one nameless detail, and the
         * Add menu had nothing in it but defects. A fallback is the profile a
         * seller gets on a bad connection, so it has to be the real one.
         */
        val clothingFallback = PhotoProfile(
            category = "clothing",
            label = "Clothing",
            roles = listOf(
                PhotoRole("front", "Front", "Lay flat, full front in frame", required = true, icon = "shirt"),
                PhotoRole("back", "Back", "Same crop as the front shot", required = true, icon = "shirt"),
                PhotoRole("tag", "Brand label", "The maker's logo or wordmark", required = false, icon = "tag", role = "brand"),
                PhotoRole("tag", "Size tag", "The size itself, close enough to read without zooming", required = false, icon = "tag", role = "size"),
                PhotoRole("tag", "Care & fabric", "The care label with the fibre content", required = false, icon = "tag", role = "care"),
                PhotoRole("detail", "Fabric close-up", "Fill the frame with the weave or knit, in even light", required = false, icon = "search", role = "fabric"),
                PhotoRole("detail", "Hardware", "Zip pull, buttons, rivets or snaps", required = false, icon = "search", role = "hardware"),
                PhotoRole("detail", "Print or graphic", "The graphic straight on, close enough to show cracking", required = false, icon = "search", role = "print"),
                PhotoRole("measurement", "Measurement card", "Whole garment flat with the MeasureCard BESIDE it, shot top-down", required = false, icon = "ruler"),
                PhotoRole("defect", "Defect", "Tight crop on any flaw — be honest", required = false, icon = "alert-triangle"),
                PhotoRole("interior", "Interior / Lining", "Inside-out: lining, seams, interior tags", required = false, icon = "layers"),
                PhotoRole("detail", "Hem & stitching", "A hem or seam up close", required = false, icon = "search", role = "hem"),
                PhotoRole("tag", "Made in / union label", "Origin, union or RN label", required = false, icon = "tag", role = "made_in"),
                PhotoRole("flatlay", "Flat lay", "Styled flat lay for the listing gallery", required = false, icon = "layout-grid"),
                PhotoRole("on_hanger", "On hanger", "Hung straight on, showing how it drapes", required = false, icon = "shirt"),
                PhotoRole("on_model", "On model", "Worn on a model or mannequin", required = false, icon = "user"),
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

    /**
     * US-2469: resolves the profile for an item, consulting the free-text
     * GARMENT word ("blazer", "dress pants") as well as the item_category.
     *
     * Mirrors `getPhotoProfile(category, garment)` on the edge, including its
     * fallback: when no usable item_category is given, the garment word resolves
     * a group and that group maps back to an item_category profile where one
     * exists. That matters because `items_full` has no item_category column at
     * all, so a free-text word is often the only thing a caller has.
     *
     * The clothing sub-profiles are keyed "clothing:top", "clothing:suit" and
     * friends, so a t-shirt is never offered an inseam slot and a blazer IS
     * offered a shoulder — which `item_category` alone cannot tell apart,
     * because it says "clothing" for both.
     */
    fun profileFor(category: String?, garment: String?): PhotoProfile {
        // An explicit, known item_category wins outright.
        if (!category.isNullOrEmpty() && category != "clothing") {
            profiles[category]?.let { return it }
        }
        val group = GarmentGroup.from(garment ?: category)
        group.itemCategoryProfileKey?.let { key -> profiles[key]?.let { return it } }
        profiles[group.clothingProfileKey]?.let { return it }
        return profileFor(category)
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
