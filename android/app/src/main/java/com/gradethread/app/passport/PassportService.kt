package com.gradethread.app.passport

import com.gradethread.app.platform.net.EdgeApi
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URLEncoder
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

@Serializable
private data class ItemLink(@SerialName("grade_report_id") val gradeReportId: String? = null)

@Serializable
private data class ReportLink(@SerialName("garment_id") val garmentId: String? = null)

@Serializable
private data class GarmentRow(
    val id: String = "",
    @SerialName("public_passport_slug") val publicPassportSlug: String = "",
)

/**
 * The two identifiers the passport surface needs.
 *
 * [slug] reads the public chain; [garmentId] is what the owner-only claim mint
 * takes. The resolve walk already reads both off the same row, and dropping the
 * id meant the handoff had no id to work from at all.
 */
data class PassportRef(val garmentId: String, val slug: String)

/** A minted claim link. The raw token exists only here and is never stored. */
@Serializable
data class PassportHandoff(
    val token: String = "",
    @SerialName("claim_url") val claimUrl: String = "",
    @SerialName("expires_at") val expiresAt: String = "",
)

/**
 * US-1376: resolve an item to its passport, then read the public chain.
 *
 * The identity chain is three hops:
 *
 *   inventory_items.grade_report_id → grade_reports.garment_id
 *                                   → garments.public_passport_slug
 *
 * The intermediate reads go through the RLS-scoped client (owner-readable);
 * the timeline itself is the PUBLIC, PII-free edge endpoint. Nothing here needs
 * the seller's identity, and nothing here asks for it.
 */
interface PassportProviding {
    /** The passport ids for an item, or null when it has none yet. */
    suspend fun resolve(inventoryItemId: String): PassportRef?

    suspend fun timeline(slug: String): PassportTimeline

    /**
     * US-2494: mint a single-use ownership-claim link for the buyer.
     *
     * The server verifies the garment belongs to this workspace before minting
     * and stores only a HASH, so the raw link comes back exactly once and can
     * never be fetched again.
     */
    suspend fun mintClaimLink(garmentId: String): PassportHandoff
}

@Singleton
class PassportService @Inject constructor(
    private val client: SupabaseClient,
    @Named("shared") private val edge: EdgeApi,
) : PassportProviding {

    companion object {
        fun path(slug: String): String =
            "/api/passport/" + URLEncoder.encode(slug, "UTF-8").replace("+", "%20")

        fun claimTokenPath(garmentId: String): String =
            "/api/passport/garments/" +
                URLEncoder.encode(garmentId, "UTF-8").replace("+", "%20") +
                "/claim-token"

        private val json = Json { ignoreUnknownKeys = true }
    }

    /**
     * Null at any broken link in the chain, never an exception.
     *
     * An ungraded item, or a legacy grade that predates the passport backfill,
     * simply has no passport. That is an ordinary state for most of an
     * inventory, not a failure worth an error banner.
     */
    override suspend fun resolve(inventoryItemId: String): PassportRef? {
        val reportId = client.from("inventory_items")
            .select(Columns.raw("grade_report_id")) {
                filter { eq("id", inventoryItemId) }
                limit(1)
            }
            .decodeList<ItemLink>()
            .firstOrNull()
            ?.gradeReportId ?: return null

        val garmentId = client.from("grade_reports")
            .select(Columns.raw("garment_id")) {
                filter { eq("id", reportId) }
                limit(1)
            }
            .decodeList<ReportLink>()
            .firstOrNull()
            ?.garmentId ?: return null

        val row = client.from("garments")
            .select(Columns.raw("id, public_passport_slug")) {
                filter { eq("id", garmentId) }
                limit(1)
            }
            .decodeList<GarmentRow>()
            .firstOrNull() ?: return null

        if (row.id.isBlank() || row.publicPassportSlug.isBlank()) return null
        return PassportRef(garmentId = row.id, slug = row.publicPassportSlug)
    }

    override suspend fun timeline(slug: String): PassportTimeline = json.decodeFromString(
        PassportTimeline.serializer(),
        edge.getRaw(path(slug)),
    )

    override suspend fun mintClaimLink(garmentId: String): PassportHandoff = json.decodeFromString(
        PassportHandoff.serializer(),
        // No body: the garment is named in the path and the owner is the
        // caller's token. Nothing about the mint is decided by the client.
        edge.postRaw(claimTokenPath(garmentId), "{}"),
    )
}
