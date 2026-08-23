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

        /**
         * US-2812: mirrors SHOES in photo-profiles.ts verbatim.
         *
         * The bundled table covered `clothing` and `other` only, so a shoe
         * captured while the profile fetch was unavailable was offered
         * Front/Back/Detail instead of Top/Heel/3/4 Angle/Sole/Size
         * Stamp/Insole — leaving the seller with photos that cannot show a
         * sole, the one surface a shoe buyer looks at first.
         *
         * A DEGRADED-MODE path. The server table is the source of truth and
         * is fetched per session; this only decides what happens before it
         * answers.
         */
        val shoesFallback = PhotoProfile(
            category = "shoes",
            label = "Shoes",
            roles = listOf(
                PhotoRole(
                    "front", "Top / Toe", "Top-down or front; show both shoes if a pair",
                    required = true, icon = "footprints",
                ),
                PhotoRole("back", "Heel", "Back of the heel, both shoes", required = true, icon = "footprints"),
                PhotoRole(
                    "angle", "3/4 Angle", "Angled side view showing the silhouette",
                    required = true, icon = "footprints",
                ),
                PhotoRole("sole", "Sole", "Outsole / tread — show wear honestly", required = true, icon = "footprints"),
                PhotoRole("tag", "Size Stamp", "Tongue or insole size + brand stamp", required = false, icon = "tag"),
                PhotoRole(
                    "interior", "Insole", "Inside the shoe — footbed condition",
                    required = false, icon = "layers",
                ),
                PhotoRole(
                    "accessory", "Box / Extras", "Original box, spare laces, papers",
                    required = false, icon = "package",
                ),
                PhotoRole(
                    "defect", "Defect", "Tight crop on any flaw — stain, snag, scuff, crack. Be honest.",
                    required = false, icon = "alert-triangle",
                ),
            ),
        )

        val bundledFallback: Map<String, PhotoProfile> = mapOf(
            "clothing" to clothingFallback,
            "shoes" to shoesFallback,
            "other" to genericFallback,
        )
    }
}

/**
 * Fetches + caches the profile table; a single fetch per session (the edge
 * caches server-side too). Bundled profiles guarantee callers can ALWAYS
 * resolve a profile — a fetch failure is non-fatal and retries next session.
 *
 * US-2496: the table is NOT account-blind. `GET /api/flipdesk/photo-profiles`
 * answers per `workspaceOwnerId ?? userId` - a seller who cannot use the
 * authenticity add-on is served fewer roles - so a table fetched for one tenant
 * is the wrong answer for the next one. This store is a process-wide singleton
 * that outlives both a sign-out and a workspace switch, so the table carries
 * the owner it was fetched FOR ([ownerProvider]) and is only ever handed back
 * to that owner. A stale table reads as "not loaded": callers get the bundled
 * fallback and the next [loadIfNeeded] refetches.
 *
 * The stamp is the mechanism deliberately, rather than a reset called from the
 * sign-out and switch paths. A stamp cannot be forgotten by a future exit path,
 * and this cache has three of them already (sign-out, workspace switch, and the
 * involuntary switch when a membership is revoked mid-session).
 */
class PhotoProfileStore(
    private val api: EdgeApi,
    /** Active workspace owner, else the signed-in user; null when signed out. */
    private val ownerProvider: () -> String? = { null },
) {

    @Serializable
    internal data class Wrapper(val profiles: Map<String, PhotoProfile>)

    /** A loaded table plus the tenant it was loaded for. */
    private class Loaded(val owner: String?, val profiles: Map<String, PhotoProfile>)

    @Volatile
    private var loaded: Loaded? = null

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * The server table when it belongs to the CURRENT tenant, else the bundled
     * fallback. Checked on every read rather than only at load time, because
     * the surfaces that display a profile (retag, the photo manager) do not all
     * call [loadIfNeeded] first - a check that only ran on load would leave
     * them showing the previous account's table until capture was opened.
     */
    private val profiles: Map<String, PhotoProfile>
        get() {
            val owner = ownerProvider() ?: return PhotoProfile.bundledFallback
            return loaded?.takeIf { it.owner == owner }?.profiles
                ?: PhotoProfile.bundledFallback
        }

    /** Clothing is the historical default for null/unknown categories. */
    fun profileFor(category: String?): PhotoProfile {
        val table = profiles
        category?.let { table[it] }?.let { return it }
        return table["clothing"] ?: PhotoProfile.clothingFallback
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
        // One snapshot for the whole resolution: re-reading the tenant between
        // the lookups could mix two tables in one answer.
        val table = profiles
        // An explicit, known item_category wins outright.
        if (!category.isNullOrEmpty() && category != "clothing") {
            table[category]?.let { return it }
        }
        val group = GarmentGroup.from(garment ?: category)
        group.itemCategoryProfileKey?.let { key -> table[key]?.let { return it } }
        table[group.clothingProfileKey]?.let { return it }
        return profileFor(category)
    }

    /**
     * Load once PER TENANT from the edge (1h TTL cache); safe to call
     * repeatedly. Signed out there is no tenant to load for, so this is a no-op
     * and callers keep the bundled fallback.
     */
    suspend fun loadIfNeeded() {
        val owner = ownerProvider() ?: return
        if (loaded?.owner == owner) return
        runCatching {
            val body = api.getRaw("/api/flipdesk/photo-profiles", cacheTtlMillis = 3_600_000)
            val wrapper = json.decodeFromString(Wrapper.serializer(), body)
            // Stamped with the owner resolved BEFORE the request. A switch that
            // landed mid-flight leaves this table stamped for the tenant it was
            // actually fetched for, so the new tenant reads it as stale and
            // refetches - rather than inheriting an answer meant for someone else.
            if (wrapper.profiles.isNotEmpty()) {
                loaded = Loaded(owner, wrapper.profiles)
            }
        } // failure keeps the bundled fallback — retry next session
    }
}
