package com.gradethread.app.autolister

import com.gradethread.app.platform.net.EdgeApi
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2964: the four description-block routes (US-2958), from Android.
 *
 *   GET  /:listingId/blocks      load, converting a legacy description on the way
 *   POST /preview                render an unsaved array
 *   POST /:listingId/save        persist blocks + the string they render to
 *   POST /:listingId/regenerate  rewrite one AI block
 *
 * CONVERT-ON-OPEN IS NOT A WRITE. The GET returns the parsed blocks AND the
 * string they render to; that string is used as the first preview VERBATIM
 * rather than being re-requested, which is what makes "the preview equals the
 * stored description byte for byte before any edit" true rather than nearly
 * true.
 *
 * NOTHING here renders a description. The renderer is edge-only by design, so
 * every string this app shows a seller is one the server produced - which is
 * also why a draft edited on a phone and opened on the web shows the same bytes.
 *
 * The regenerate call runs a model server-side and sends nothing back until the
 * copy is written, so it uses the AI client (120s read) rather than the shared
 * one (20s). On the short client it would fail every time while the server
 * finished the work and billed the seller's quota for it.
 */
@Singleton
class DescriptionBlocksService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
    @Named("ai") private val aiEdge: EdgeApi,
    private val client: SupabaseClient,
) {

    companion object {
        private const val BASE = "/api/flipdesk/description"

        fun blocksPath(listingId: String) = "$BASE/$listingId/blocks"
        fun savePath(listingId: String) = "$BASE/$listingId/save"
        fun regeneratePath(listingId: String) = "$BASE/$listingId/regenerate"
        const val PREVIEW_PATH = "$BASE/preview"

        /**
         * Its own Json rather than the client's.
         *
         * `encodeDefaults` so `on = true` is written rather than left to the
         * server's default, and `explicitNulls = false` so an absent `sep` stays
         * absent - it is the whitespace that precedes the block, and sending a
         * null where the server sent nothing would renormalise the buyer-facing
         * spacing of every converted listing on its first save.
         */
        val json = Json {
            ignoreUnknownKeys = true
            isLenient = true
            encodeDefaults = true
            explicitNulls = false
        }
    }

    // ── Wire types ──────────────────────────────────────────────────────────

    @Serializable
    data class BlocksResponse(
        val blocks: List<DescriptionBlock> = emptyList(),
        /** The exact bytes the current array renders to. Adopt verbatim. */
        val preview: String = "",
        /** These rows came from parsing a legacy string; nothing is stored yet. */
        val converted: Boolean = false,
    )

    /** What /save and /regenerate both answer with. */
    @Serializable
    data class SavedResponse(val blocks: List<DescriptionBlock> = emptyList(), val description: String = "")

    @Serializable
    private data class PreviewResponse(val preview: String = "")

    @Serializable
    private data class PreviewRequest(
        @SerialName("listing_id") val listingId: String,
        val blocks: List<DescriptionBlock>,
        val unit: String,
    )

    @Serializable
    private data class SaveRequest(val blocks: List<DescriptionBlock>, val unit: String)

    @Serializable
    private data class RegenerateRequest(val block: String, val unit: String)

    @Serializable
    data class ListingSnippet(val id: String = "", val name: String = "")

    /**
     * The item columns a derived row's one-line summary reads.
     *
     * The row is a control, not a preview, so it says WHICH attributes it will
     * print rather than printing them - but it has to know which ones are
     * filled, or every draft would claim "No attributes filled in yet" while the
     * rendered description showed four of them.
     */
    @Serializable
    data class ItemFacts(
        val brand: String? = null,
        val size: String? = null,
        val color: String? = null,
        val material: String? = null,
        val style: String? = null,
        val measurements: Map<String, Double>? = null,
        @SerialName("grade_value") val gradeValue: Double? = null,
    )

    // ── Calls ───────────────────────────────────────────────────────────────

    /** The listing's blocks, plus the string they render to. */
    suspend fun load(listingId: String, unit: String = "in"): BlocksResponse = json.decodeFromString(
        BlocksResponse.serializer(),
        edge.getRaw(blocksPath(listingId), mapOf("unit" to unit)),
    )

    /**
     * Render an unsaved array. Read-only server-side, so a seller who backs out
     * of the editor has changed nothing.
     */
    suspend fun preview(listingId: String, blocks: List<DescriptionBlock>, unit: String = "in"): String =
        json.decodeFromString(
            PreviewResponse.serializer(),
            edge.postRaw(
                PREVIEW_PATH,
                json.encodeToString(
                    PreviewRequest.serializer(),
                    PreviewRequest(listingId = listingId, blocks = blocks, unit = unit),
                ),
            ),
        ).preview

    /** Persist the array and the string it renders to, in one update. */
    suspend fun save(listingId: String, blocks: List<DescriptionBlock>, unit: String = "in"): SavedResponse =
        json.decodeFromString(
            SavedResponse.serializer(),
            edge.postRaw(
                savePath(listingId),
                json.encodeToString(
                    SaveRequest.serializer(),
                    SaveRequest(blocks = blocks, unit = unit),
                ),
            ),
        )

    /**
     * Rewrite ONE ai block. Every other entry comes back byte-identical, which
     * is what makes "redo one sentence" not a full rewrite.
     *
     * The AI client, not the shared one: the server runs a model before it
     * answers.
     */
    suspend fun regenerate(listingId: String, block: DescriptionBlockKey, unit: String = "in"): SavedResponse =
        json.decodeFromString(
            SavedResponse.serializer(),
            aiEdge.postRaw(
                regeneratePath(listingId),
                json.encodeToString(
                    RegenerateRequest.serializer(),
                    RegenerateRequest(block = wireKey(block), unit = unit),
                ),
            ),
        )

    /**
     * The seller's standing lines, for the "Add a snippet" menu (US-2961).
     *
     * Read straight from `listing_snippets` under RLS rather than through the
     * edge: they are the caller's own rows and the policy already scopes them,
     * so a route would add a hop without adding a rule. The web settings page
     * reads it the same way.
     */
    suspend fun snippets(): List<ListingSnippet> = client.from("listing_snippets").select(Columns.raw("id, name")) {
        order("sort_order", Order.ASCENDING)
    }.decodeList()

    /**
     * The item behind a draft, for the row summaries. Read under RLS, which
     * scopes it to the owner.
     */
    suspend fun itemFacts(itemId: String): ItemFacts? = client.from("inventory_items")
        .select(
            Columns.raw("brand, size, color, material, style, measurements, grade_value"),
        ) {
            filter { eq("id", itemId) }
            limit(1)
        }
        .decodeList<ItemFacts>()
        .firstOrNull()

    /** The wire spelling of a block key, which is the enum's serial name. */
    fun wireKey(key: DescriptionBlockKey): String = when (key) {
        DescriptionBlockKey.INTRO -> "intro"
        DescriptionBlockKey.FEATURES -> "features"
        DescriptionBlockKey.CONDITION -> "condition"
        DescriptionBlockKey.ATTRIBUTES -> "attributes"
        DescriptionBlockKey.MEASUREMENTS -> "measurements"
        DescriptionBlockKey.GRADE -> "grade"
        DescriptionBlockKey.DISCLOSURE -> "disclosure"
        DescriptionBlockKey.CREDENTIALS -> "credentials"
        DescriptionBlockKey.FACTS -> "facts"
        DescriptionBlockKey.SNIPPET -> "snippet"
        DescriptionBlockKey.TEXT -> "text"
    }
}
