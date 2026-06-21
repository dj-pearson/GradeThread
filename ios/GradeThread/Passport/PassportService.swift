import Foundation

/// Resolves an inventory item to its Garment Passport and reads the public,
/// PII-free provenance chain (US-1115). The passport identity chain is:
///
///   inventory_items.grade_report_id → grade_reports.garment_id
///                                    → garments.public_passport_slug
///
/// The two intermediate reads go through Supabase (owner-readable under RLS,
/// same as ``ItemGradeReportService``); the timeline + claim-handoff calls go
/// through the edge (the public read is PII-free + unauthenticated, the mint is
/// authed + workspace-scoped via ``EdgeAPI``).
@MainActor
enum PassportService {

    /// A resolved passport handle for an item: the public slug (for the share
    /// URL + timeline read) and the garment id (for the owner claim-handoff mint).
    struct Ref: Equatable {
        let slug: String
        let garmentId: String
    }

    // Supabase row shapes (snake_case — the Supabase client decoder does NOT
    // convert keys, matching ItemGradeReportService).
    private struct ItemLink: Decodable { let grade_report_id: String? }
    private struct ReportLink: Decodable { let garment_id: String? }
    private struct GarmentRow: Decodable { let id: String; let public_passport_slug: String }

    /// Resolve the passport ref for an inventory item, or nil when the item has
    /// no passport yet (ungraded, or a legacy grade not yet backfilled).
    static func resolve(inventoryItemId: String) async throws -> Ref? {
        let links: [ItemLink] = try await SupabaseShared.client
            .from("inventory_items")
            .select("grade_report_id")
            .eq("id", value: inventoryItemId)
            .limit(1)
            .execute()
            .value
        guard let reportId = links.first?.grade_report_id else { return nil }

        let reports: [ReportLink] = try await SupabaseShared.client
            .from("grade_reports")
            .select("garment_id")
            .eq("id", value: reportId)
            .limit(1)
            .execute()
            .value
        guard let garmentId = reports.first?.garment_id else { return nil }

        let garments: [GarmentRow] = try await SupabaseShared.client
            .from("garments")
            .select("id, public_passport_slug")
            .eq("id", value: garmentId)
            .limit(1)
            .execute()
            .value
        guard let g = garments.first else { return nil }
        return Ref(slug: g.public_passport_slug, garmentId: g.id)
    }

    /// Read the public, PII-free provenance chain for a slug from the edge.
    static func fetchTimeline(slug: String) async throws -> PassportTimeline {
        let encoded = slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
        return try await EdgeAPI.shared.getJSON("/api/passport/\(encoded)")
    }

    /// Mint a single-use, time-bounded ownership-claim link the owner can hand
    /// off to a buyer (so they can claim the passport). Authed + workspace-scoped
    /// via ``EdgeAPI``; the raw link is returned exactly once.
    static func mintHandoffLink(garmentId: String) async throws -> PassportHandoff {
        struct Empty: Encodable {}
        let encoded = garmentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? garmentId
        let response: HandoffResponse = try await EdgeAPI.shared.postJSON(
            "/api/passport/garments/\(encoded)/claim-token",
            body: Empty()
        )
        guard let url = URL(string: response.claimUrl) else {
            throw EdgeAPIError.decoding("Malformed claim URL")
        }
        return PassportHandoff(url: url, expiresAt: response.expiresAt)
    }

    // EdgeAPI decoder is convertFromSnakeCase, so claim_url/expires_at arrive
    // camelCased.
    private struct HandoffResponse: Decodable {
        let token: String
        let claimUrl: String
        let expiresAt: String
    }
}

/// A minted ownership-claim handoff link plus its expiry (raw ISO string).
struct PassportHandoff: Equatable {
    let url: URL
    let expiresAt: String
}
