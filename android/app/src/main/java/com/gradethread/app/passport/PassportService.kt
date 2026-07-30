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
    /** The passport slug for an item, or null when it has none yet. */
    suspend fun resolveSlug(inventoryItemId: String): String?

    suspend fun timeline(slug: String): PassportTimeline
}

@Singleton
class PassportService @Inject constructor(
    private val client: SupabaseClient,
    @Named("shared") private val edge: EdgeApi,
) : PassportProviding {

    companion object {
        fun path(slug: String): String =
            "/api/passport/" + URLEncoder.encode(slug, "UTF-8").replace("+", "%20")

        private val json = Json { ignoreUnknownKeys = true }
    }

    /**
     * Null at any broken link in the chain, never an exception.
     *
     * An ungraded item, or a legacy grade that predates the passport backfill,
     * simply has no passport. That is an ordinary state for most of an
     * inventory, not a failure worth an error banner.
     */
    override suspend fun resolveSlug(inventoryItemId: String): String? {
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

        return client.from("garments")
            .select(Columns.raw("id, public_passport_slug")) {
                filter { eq("id", garmentId) }
                limit(1)
            }
            .decodeList<GarmentRow>()
            .firstOrNull()
            ?.publicPassportSlug
            ?.takeIf { it.isNotBlank() }
    }

    override suspend fun timeline(slug: String): PassportTimeline = json.decodeFromString(
        PassportTimeline.serializer(),
        edge.getRaw(path(slug)),
    )
}
