import Foundation
import Supabase

/// Data layer for listing templates (US-674). Reads/writes `listing_templates`
/// directly through supabase-swift — every query rides the signed-in user's JWT,
/// so RLS scopes rows to the owner (the same pattern as ``ListingDraftService``
/// and ``SalesStore``). Direct supabase (not the EdgeAPI client) is deliberate:
/// EdgeAPI's snake_case key conversion would corrupt the free-form
/// `item_specifics` map keys. Behind a protocol so ``TemplateStore`` is
/// unit-testable with a fake.
protocol TemplateProviding {
    func list() async throws -> [ListingTemplate]
    func create(_ draft: TemplateDraft) async throws -> ListingTemplate
    func update(id: String, _ draft: TemplateDraft) async throws -> ListingTemplate
    func delete(id: String) async throws
}

enum TemplateServiceError: LocalizedError {
    case emptyResponse
    var errorDescription: String? { "The server didn't return the saved template." }
}

struct TemplateService: TemplateProviding {
    private static let columns =
        "id, name, description_template, ebay_condition, condition_description, " +
        "item_specifics, ebay_category_id, return_policy_id, shipping_policy_id, " +
        "payment_policy_id, is_default, sort_order"

    func list() async throws -> [ListingTemplate] {
        // RLS scopes SELECT to the caller (auth.uid() = user_id).
        let rows: [ListingTemplate] = try await SupabaseShared.client
            .from("listing_templates")
            .select(Self.columns)
            .order("sort_order", ascending: true)
            .order("name", ascending: true)
            .execute()
            .value
        return rows
    }

    func create(_ draft: TemplateDraft) async throws -> ListingTemplate {
        let userId = try await SupabaseShared.client.auth.session.user.id.uuidString
        if draft.isDefault { try await clearDefaults() }
        let rows: [ListingTemplate] = try await SupabaseShared.client
            .from("listing_templates")
            .insert(Payload(draft, userId: userId))
            .select(Self.columns)
            .execute()
            .value
        guard let row = rows.first else { throw TemplateServiceError.emptyResponse }
        return row
    }

    func update(id: String, _ draft: TemplateDraft) async throws -> ListingTemplate {
        // Clear any existing default first; if this template IS the new default
        // the update below re-sets it, so the single-default index always holds.
        if draft.isDefault { try await clearDefaults() }
        // RLS scopes UPDATE to the caller; the id targets the row.
        let rows: [ListingTemplate] = try await SupabaseShared.client
            .from("listing_templates")
            .update(Patch(draft))
            .eq("id", value: id)
            .select(Self.columns)
            .execute()
            .value
        guard let row = rows.first else { throw TemplateServiceError.emptyResponse }
        return row
    }

    func delete(id: String) async throws {
        // RLS scopes DELETE to the caller (auth.uid() = user_id).
        try await SupabaseShared.client
            .from("listing_templates")
            .delete()
            .eq("id", value: id)
            .execute()
    }

    /// Clear the caller's current default(s) so the single-default partial index
    /// holds when a new default is set. RLS limits this to the caller's rows.
    private func clearDefaults() async throws {
        struct Flag: Encodable { let is_default: Bool }
        try await SupabaseShared.client
            .from("listing_templates")
            .update(Flag(is_default: false))
            .eq("is_default", value: true)
            .execute()
    }

    // snake_case payloads — supabase-swift encodes property names as-is (no key
    // conversion), so the free-form item_specifics map round-trips intact.
    private struct Payload: Encodable {
        let user_id: String
        let name: String
        let description_template: String?
        let ebay_condition: String?
        let condition_description: String?
        let item_specifics: [String: String]
        let ebay_category_id: String?
        let return_policy_id: String?
        let shipping_policy_id: String?
        let payment_policy_id: String?
        let is_default: Bool
        let sort_order: Int

        init(_ d: TemplateDraft, userId: String) {
            user_id = userId
            name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
            description_template = Self.nilIfBlank(d.descriptionTemplate)
            ebay_condition = Self.nilIfBlank(d.ebayCondition)
            condition_description = Self.nilIfBlank(d.conditionDescription)
            item_specifics = Self.cleanSpecifics(d.itemSpecifics)
            ebay_category_id = Self.nilIfBlank(d.ebayCategoryId)
            return_policy_id = Self.nilIfBlank(d.returnPolicyId)
            shipping_policy_id = Self.nilIfBlank(d.shippingPolicyId)
            payment_policy_id = Self.nilIfBlank(d.paymentPolicyId)
            is_default = d.isDefault
            sort_order = d.sortOrder
        }

        static func nilIfBlank(_ s: String) -> String? {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        static func cleanSpecifics(_ m: [String: String]) -> [String: String] {
            m.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
    }

    /// Update payload: identical to ``Payload`` minus the immutable `user_id`.
    /// A custom encoder writes explicit JSON `null` (not omission) for blanked
    /// optionals, so editing a field to empty actually clears the column —
    /// `encodeIfPresent` would leave the old value in place.
    private struct Patch: Encodable {
        let name: String
        let description_template: String?
        let ebay_condition: String?
        let condition_description: String?
        let item_specifics: [String: String]
        let ebay_category_id: String?
        let return_policy_id: String?
        let shipping_policy_id: String?
        let payment_policy_id: String?
        let is_default: Bool
        let sort_order: Int

        init(_ d: TemplateDraft) {
            name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
            description_template = Payload.nilIfBlank(d.descriptionTemplate)
            ebay_condition = Payload.nilIfBlank(d.ebayCondition)
            condition_description = Payload.nilIfBlank(d.conditionDescription)
            item_specifics = Payload.cleanSpecifics(d.itemSpecifics)
            ebay_category_id = Payload.nilIfBlank(d.ebayCategoryId)
            return_policy_id = Payload.nilIfBlank(d.returnPolicyId)
            shipping_policy_id = Payload.nilIfBlank(d.shippingPolicyId)
            payment_policy_id = Payload.nilIfBlank(d.paymentPolicyId)
            is_default = d.isDefault
            sort_order = d.sortOrder
        }

        enum CodingKeys: String, CodingKey {
            case name, description_template, ebay_condition, condition_description
            case item_specifics, ebay_category_id, return_policy_id
            case shipping_policy_id, payment_policy_id, is_default, sort_order
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(name, forKey: .name)
            // encode (not encodeIfPresent) → nil becomes JSON null → column NULL.
            try c.encode(description_template, forKey: .description_template)
            try c.encode(ebay_condition, forKey: .ebay_condition)
            try c.encode(condition_description, forKey: .condition_description)
            try c.encode(item_specifics, forKey: .item_specifics)
            try c.encode(ebay_category_id, forKey: .ebay_category_id)
            try c.encode(return_policy_id, forKey: .return_policy_id)
            try c.encode(shipping_policy_id, forKey: .shipping_policy_id)
            try c.encode(payment_policy_id, forKey: .payment_policy_id)
            try c.encode(is_default, forKey: .is_default)
            try c.encode(sort_order, forKey: .sort_order)
        }
    }
}
