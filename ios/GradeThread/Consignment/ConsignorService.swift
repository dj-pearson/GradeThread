import Foundation
import Supabase

/// Data layer for consignors (US-676). Reads/writes the `consignors` table
/// directly through supabase-swift — every query rides the signed-in user's JWT,
/// so RLS scopes rows to the owner (same pattern as ``TemplateService``). Behind
/// a protocol so ``ConsignorStore`` is unit-testable with a fake.
protocol ConsignorProviding {
    func list() async throws -> [Consignor]
    func create(_ draft: ConsignorDraft) async throws -> Consignor
    func update(id: String, _ draft: ConsignorDraft) async throws -> Consignor
    func delete(id: String) async throws
}

enum ConsignorServiceError: LocalizedError {
    case emptyResponse
    var errorDescription: String? { "The server didn't return the saved consignor." }
}

struct ConsignorService: ConsignorProviding {
    private static let columns =
        "id, name, contact_email, contact_phone, default_split_pct, notes"

    func list() async throws -> [Consignor] {
        let rows: [Consignor] = try await SupabaseShared.client
            .from("consignors")
            .select(Self.columns)
            .order("name", ascending: true)
            .execute()
            .value
        return rows
    }

    func create(_ draft: ConsignorDraft) async throws -> Consignor {
        let userId = try await SupabaseShared.client.auth.session.user.id.uuidString
        let rows: [Consignor] = try await SupabaseShared.client
            .from("consignors")
            .insert(Payload(draft, userId: userId))
            .select(Self.columns)
            .execute()
            .value
        guard let row = rows.first else { throw ConsignorServiceError.emptyResponse }
        return row
    }

    func update(id: String, _ draft: ConsignorDraft) async throws -> Consignor {
        // RLS scopes UPDATE to the caller; the id targets the row.
        let rows: [Consignor] = try await SupabaseShared.client
            .from("consignors")
            .update(Patch(draft))
            .eq("id", value: id)
            .select(Self.columns)
            .execute()
            .value
        guard let row = rows.first else { throw ConsignorServiceError.emptyResponse }
        return row
    }

    func delete(id: String) async throws {
        // RLS scopes DELETE to the caller. inventory_items.consignor_id is
        // ON DELETE SET NULL, so removing a consignor un-links (not deletes)
        // their items.
        try await SupabaseShared.client
            .from("consignors")
            .delete()
            .eq("id", value: id)
            .execute()
    }

    private struct Payload: Encodable {
        let user_id: String
        let name: String
        let contact_email: String?
        let contact_phone: String?
        let default_split_pct: Double
        let notes: String?

        init(_ d: ConsignorDraft, userId: String) {
            user_id = userId
            name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
            contact_email = Self.nilIfBlank(d.contactEmail)
            contact_phone = Self.nilIfBlank(d.contactPhone)
            default_split_pct = min(max(d.defaultSplitPct, 0), 100)
            notes = Self.nilIfBlank(d.notes)
        }

        static func nilIfBlank(_ s: String) -> String? {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
    }

    /// Update payload — explicit `encode` (not `encodeIfPresent`) so blanking a
    /// field actually clears the column to NULL.
    private struct Patch: Encodable {
        let name: String
        let contact_email: String?
        let contact_phone: String?
        let default_split_pct: Double
        let notes: String?

        init(_ d: ConsignorDraft) {
            name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
            contact_email = Payload.nilIfBlank(d.contactEmail)
            contact_phone = Payload.nilIfBlank(d.contactPhone)
            default_split_pct = min(max(d.defaultSplitPct, 0), 100)
            notes = Payload.nilIfBlank(d.notes)
        }

        enum CodingKeys: String, CodingKey {
            case name, contact_email, contact_phone, default_split_pct, notes
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(name, forKey: .name)
            try c.encode(contact_email, forKey: .contact_email)
            try c.encode(contact_phone, forKey: .contact_phone)
            try c.encode(default_split_pct, forKey: .default_split_pct)
            try c.encode(notes, forKey: .notes)
        }
    }
}
