import Foundation

/// Loads the stored certified-grade report for an already-graded inventory
/// item directly from Supabase (owner-readable under RLS), for the "view full
/// report" path on the canvas. The live request flow gets its report from the
/// edge bridge instead; this is for grades that completed in a past session.
@MainActor
enum ItemGradeReportService {

    /// inventory_items shape we read to find the linked report id.
    private struct ItemLink: Decodable {
        let grade_report_id: String?
        let certificate_url: String?
    }

    /// grade_reports shape (snake_case to match the column names — the
    /// Supabase client decoder does not convert keys).
    private struct ReportRow: Decodable {
        let id: String
        let overall_score: Double
        let grade_tier: String
        let fabric_condition_score: Double
        let structural_integrity_score: Double
        let cosmetic_appearance_score: Double
        let functional_elements_score: Double
        let odor_cleanliness_score: Double
        let ai_summary: String
        let confidence_score: Double
        let certificate_id: String?
        let created_at: String?
    }

    struct LoadedReport {
        let report: GradeReportDTO
        let certificateURL: URL?
    }

    /// Fetch the report for `inventoryItemId`, or nil if the item has no grade
    /// report yet. Throws on a network/permission failure.
    static func load(inventoryItemId: String) async throws -> LoadedReport? {
        let links: [ItemLink] = try await SupabaseShared.client
            .from("inventory_items")
            .select("grade_report_id, certificate_url")
            .eq("id", value: inventoryItemId)
            .limit(1)
            .execute()
            .value
        guard let reportId = links.first?.grade_report_id else { return nil }
        let certificateUrlString = links.first?.certificate_url

        let rows: [ReportRow] = try await SupabaseShared.client
            .from("grade_reports")
            .select(
                "id, overall_score, grade_tier, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, ai_summary, confidence_score, certificate_id, created_at"
            )
            .eq("id", value: reportId)
            .limit(1)
            .execute()
            .value
        guard let row = rows.first else { return nil }

        let dto = GradeReportDTO(
            id: row.id,
            overallScore: row.overall_score,
            gradeTier: row.grade_tier,
            fabricConditionScore: row.fabric_condition_score,
            structuralIntegrityScore: row.structural_integrity_score,
            cosmeticAppearanceScore: row.cosmetic_appearance_score,
            functionalElementsScore: row.functional_elements_score,
            odorCleanlinessScore: row.odor_cleanliness_score,
            aiSummary: row.ai_summary,
            confidenceScore: row.confidence_score,
            certificateId: row.certificate_id,
            createdAt: row.created_at
        )
        let url = CertificateLink.resolve(
            explicit: certificateUrlString,
            certificateId: row.certificate_id
        )
        return LoadedReport(report: dto, certificateURL: url)
    }
}
