package com.gradethread.app.grading

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Singleton

/** A genuine wear/damage finding — not an intentional design feature. */
data class GradeDefect(
    val defect: String,
    val severity: String,
    val location: String?,
    val impactOnGrade: String?,
)

/** A stored report plus everything the report screen needs around it. */
data class LoadedGradeReport(
    val report: GradeReportDto,
    val defects: List<GradeDefect>,
    val certificateUrl: String?,
    val itemTitle: String?,
)

/**
 * US-1337: loads the stored report for an already-graded item (iOS
 * `ItemGradeReportService`).
 *
 * Read through the ANON client, so row-level security is the tenant boundary —
 * unlike the edge's service-role paths, this cannot see another account's rows
 * even if handed their id.
 *
 * The live request flow gets its report from the bridge poll instead; this is
 * for grades that completed in an earlier session, and it is the only path
 * that carries `defects_found` (the bridge's status projection omits it).
 */
@Singleton
class ItemGradeReportRepository @Inject constructor(private val client: SupabaseClient) {

    suspend fun load(inventoryItemId: String): LoadedGradeReport? {
        val links = client.from(ITEMS).select(columns = ITEM_COLUMNS) {
            filter { eq("id", inventoryItemId) }
            limit(1)
        }.decodeList<ItemLinkRow>()
        val link = links.firstOrNull() ?: return null
        val reportId = link.gradeReportId ?: return null

        val rows = client.from(REPORTS).select(columns = REPORT_COLUMNS) {
            filter { eq("id", reportId) }
            limit(1)
        }.decodeList<ReportRow>()
        val row = rows.firstOrNull() ?: return null

        return LoadedGradeReport(
            report = GradeReportDto(
                id = row.id,
                overallScore = row.overallScore,
                gradeTier = row.gradeTier,
                fabricConditionScore = row.fabricConditionScore,
                structuralIntegrityScore = row.structuralIntegrityScore,
                cosmeticAppearanceScore = row.cosmeticAppearanceScore,
                functionalElementsScore = row.functionalElementsScore,
                odorCleanlinessScore = row.odorCleanlinessScore,
                aiSummary = row.aiSummary,
                confidenceScore = row.confidenceScore,
                certificateId = row.certificateId,
                createdAt = row.createdAt,
            ),
            defects = row.defectsFound.orEmpty().map {
                GradeDefect(it.defect, it.severity, it.location, it.impactOnGrade)
            },
            certificateUrl = CertificateLink.resolve(link.certificateUrl, row.certificateId),
            itemTitle = link.title,
        )
    }

    private companion object {
        const val ITEMS = "inventory_items"
        const val REPORTS = "grade_reports"
        val ITEM_COLUMNS = io.github.jan.supabase.postgrest.query.Columns.raw(
            "grade_report_id, certificate_url, title",
        )
        val REPORT_COLUMNS = io.github.jan.supabase.postgrest.query.Columns.raw(
            "id, overall_score, grade_tier, fabric_condition_score, " +
                "structural_integrity_score, cosmetic_appearance_score, " +
                "functional_elements_score, odor_cleanliness_score, ai_summary, " +
                "confidence_score, certificate_id, created_at, defects_found",
        )
    }
}

@Serializable
private data class ItemLinkRow(
    @SerialName("grade_report_id") val gradeReportId: String? = null,
    @SerialName("certificate_url") val certificateUrl: String? = null,
    val title: String? = null,
)

@Serializable
private data class DefectRow(
    val defect: String = "",
    val severity: String = "",
    val location: String? = null,
    @SerialName("impact_on_grade") val impactOnGrade: String? = null,
)

@Serializable
private data class ReportRow(
    val id: String = "",
    @SerialName("overall_score") val overallScore: Double = 0.0,
    @SerialName("grade_tier") val gradeTier: String = "",
    @SerialName("fabric_condition_score") val fabricConditionScore: Double = 0.0,
    @SerialName("structural_integrity_score") val structuralIntegrityScore: Double = 0.0,
    @SerialName("cosmetic_appearance_score") val cosmeticAppearanceScore: Double = 0.0,
    @SerialName("functional_elements_score") val functionalElementsScore: Double = 0.0,
    @SerialName("odor_cleanliness_score") val odorCleanlinessScore: Double = 0.0,
    @SerialName("ai_summary") val aiSummary: String = "",
    @SerialName("confidence_score") val confidenceScore: Double = 0.0,
    @SerialName("certificate_id") val certificateId: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("defects_found") val defectsFound: List<DefectRow>? = null,
)
