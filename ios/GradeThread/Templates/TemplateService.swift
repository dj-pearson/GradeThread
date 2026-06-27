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
        // US-1265: clearing the prior default + inserting the new one happen in
        // ONE transactional RPC (create_listing_template, migration 00317). The
        // old two-step "clear, then insert" left the seller with zero defaults if
        // the insert failed; the RPC rolls the clear back with any insert error,
        // so there's never a window of zero defaults.
        let res = try await SupabaseShared.client
            .rpc("create_listing_template", params: CreateParams(draft))
            .execute()
        return try Self.decodeRow(res.data)
    }

    func update(id: String, _ draft: TemplateDraft) async throws -> ListingTemplate {
        // US-1265: clear-other-defaults + update happen atomically in
        // update_listing_template (migration 00317) so a failed update can't
        // wipe the existing default. The function re-sets this row as the
        // default last, so the single-default partial index always holds.
        let res = try await SupabaseShared.client
            .rpc("update_listing_template", params: UpdateParams(id: id, draft))
            .execute()
        return try Self.decodeRow(res.data)
    }

    func delete(id: String) async throws {
        // RLS scopes DELETE to the caller (auth.uid() = user_id).
        try await SupabaseShared.client
            .from("listing_templates")
            .delete()
            .eq("id", value: id)
            .execute()
    }

    /// The RPCs `RETURN public.listing_templates` (a single composite row), so
    /// PostgREST replies with one JSON object. Decode it with a plain decoder —
    /// `ListingTemplate` declares explicit snake_case keys (no conversion), so
    /// the free-form `item_specifics` map survives intact.
    private static func decodeRow(_ data: Data) throws -> ListingTemplate {
        do {
            return try JSONDecoder().decode(ListingTemplate.self, from: data)
        } catch {
            throw TemplateServiceError.emptyResponse
        }
    }

    /// Normalized template fields shared by both RPC param structs. Trims + nils
    /// blank text (the server stores NULL, not "") and drops blank item-specifics
    /// rows — the same normalization the old direct-insert Payload applied.
    private struct TemplateFields {
        let name: String
        let descriptionTemplate: String?
        let ebayCondition: String?
        let conditionDescription: String?
        let itemSpecifics: [String: String]
        let ebayCategoryId: String?
        let returnPolicyId: String?
        let shippingPolicyId: String?
        let paymentPolicyId: String?
        let isDefault: Bool
        let sortOrder: Int

        init(_ d: TemplateDraft) {
            name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
            descriptionTemplate = Self.nilIfBlank(d.descriptionTemplate)
            ebayCondition = Self.nilIfBlank(d.ebayCondition)
            conditionDescription = Self.nilIfBlank(d.conditionDescription)
            itemSpecifics = Self.cleanSpecifics(d.itemSpecifics)
            ebayCategoryId = Self.nilIfBlank(d.ebayCategoryId)
            returnPolicyId = Self.nilIfBlank(d.returnPolicyId)
            shippingPolicyId = Self.nilIfBlank(d.shippingPolicyId)
            paymentPolicyId = Self.nilIfBlank(d.paymentPolicyId)
            isDefault = d.isDefault
            sortOrder = d.sortOrder
        }

        static func nilIfBlank(_ s: String) -> String? {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        static func cleanSpecifics(_ m: [String: String]) -> [String: String] {
            m.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }

        // RPC argument names (the `p_`-prefixed function params from migration
        // 00317). `encode` (not `encodeIfPresent`) so a nil sends explicit JSON
        // null — the function params have no defaults, and an omitted arg would
        // change which overload PostgREST resolves.
        enum FieldKey: String, CodingKey {
            case p_name, p_description_template, p_ebay_condition, p_condition_description
            case p_item_specifics, p_ebay_category_id, p_return_policy_id
            case p_shipping_policy_id, p_payment_policy_id, p_is_default, p_sort_order
        }

        func encode(into c: inout KeyedEncodingContainer<FieldKey>) throws {
            try c.encode(name, forKey: .p_name)
            try c.encode(descriptionTemplate, forKey: .p_description_template)
            try c.encode(ebayCondition, forKey: .p_ebay_condition)
            try c.encode(conditionDescription, forKey: .p_condition_description)
            try c.encode(itemSpecifics, forKey: .p_item_specifics)
            try c.encode(ebayCategoryId, forKey: .p_ebay_category_id)
            try c.encode(returnPolicyId, forKey: .p_return_policy_id)
            try c.encode(shippingPolicyId, forKey: .p_shipping_policy_id)
            try c.encode(paymentPolicyId, forKey: .p_payment_policy_id)
            try c.encode(isDefault, forKey: .p_is_default)
            try c.encode(sortOrder, forKey: .p_sort_order)
        }
    }

    /// Params for `create_listing_template` — no id (the function inserts and
    /// returns a fresh row). Sent verbatim (no key conversion) so the free-form
    /// item_specifics map keys round-trip intact.
    private struct CreateParams: Encodable {
        let fields: TemplateFields
        init(_ d: TemplateDraft) { fields = TemplateFields(d) }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: TemplateFields.FieldKey.self)
            try fields.encode(into: &c)
        }
    }

    /// Params for `update_listing_template` — the same fields plus the target id.
    private struct UpdateParams: Encodable {
        let id: String
        let fields: TemplateFields
        init(id: String, _ d: TemplateDraft) { self.id = id; fields = TemplateFields(d) }

        enum IdKey: String, CodingKey { case p_id }

        func encode(to encoder: Encoder) throws {
            var idC = encoder.container(keyedBy: IdKey.self)
            try idC.encode(id, forKey: .p_id)
            var c = encoder.container(keyedBy: TemplateFields.FieldKey.self)
            try fields.encode(into: &c)
        }
    }
}
