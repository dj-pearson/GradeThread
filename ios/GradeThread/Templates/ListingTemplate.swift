import Foundation

/// A reusable listing preset (US-674): description boilerplate, item-specifics
/// defaults, default eBay condition, and the shipping/return/payment business
/// policies. Mirrors the `listing_templates` row.
///
/// Read/written via supabase-swift directly (RLS-scoped to the owner), NOT the
/// EdgeAPI client — EdgeAPI's convertFromSnakeCase strategy would mangle the
/// free-form `item_specifics` map keys (e.g. "Sleeve Length"). So keys are
/// declared explicitly (the same pattern as RemoteSale / ListingDraftService).
struct ListingTemplate: Identifiable, Decodable, Equatable, Hashable {
    let id: String
    var name: String
    var descriptionTemplate: String?
    var ebayCondition: String?
    var conditionDescription: String?
    var itemSpecifics: [String: String]
    var ebayCategoryId: String?
    var returnPolicyId: String?
    var shippingPolicyId: String?
    var paymentPolicyId: String?
    var isDefault: Bool
    var sortOrder: Int

    private enum CodingKeys: String, CodingKey {
        case id, name
        case descriptionTemplate = "description_template"
        case ebayCondition = "ebay_condition"
        case conditionDescription = "condition_description"
        case itemSpecifics = "item_specifics"
        case ebayCategoryId = "ebay_category_id"
        case returnPolicyId = "return_policy_id"
        case shippingPolicyId = "shipping_policy_id"
        case paymentPolicyId = "payment_policy_id"
        case isDefault = "is_default"
        case sortOrder = "sort_order"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        descriptionTemplate = try c.decodeIfPresent(String.self, forKey: .descriptionTemplate)
        ebayCondition = try c.decodeIfPresent(String.self, forKey: .ebayCondition)
        conditionDescription = try c.decodeIfPresent(String.self, forKey: .conditionDescription)
        // jsonb is `NOT NULL DEFAULT '{}'`, but tolerate an absent/null map.
        itemSpecifics = (try? c.decode([String: String].self, forKey: .itemSpecifics)) ?? [:]
        ebayCategoryId = try c.decodeIfPresent(String.self, forKey: .ebayCategoryId)
        returnPolicyId = try c.decodeIfPresent(String.self, forKey: .returnPolicyId)
        shippingPolicyId = try c.decodeIfPresent(String.self, forKey: .shippingPolicyId)
        paymentPolicyId = try c.decodeIfPresent(String.self, forKey: .paymentPolicyId)
        isDefault = (try? c.decode(Bool.self, forKey: .isDefault)) ?? false
        sortOrder = (try? c.decode(Int.self, forKey: .sortOrder)) ?? 0
    }

    /// Memberwise initializer for tests/previews (custom decoder suppresses it).
    init(
        id: String,
        name: String,
        descriptionTemplate: String? = nil,
        ebayCondition: String? = nil,
        conditionDescription: String? = nil,
        itemSpecifics: [String: String] = [:],
        ebayCategoryId: String? = nil,
        returnPolicyId: String? = nil,
        shippingPolicyId: String? = nil,
        paymentPolicyId: String? = nil,
        isDefault: Bool = false,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.name = name
        self.descriptionTemplate = descriptionTemplate
        self.ebayCondition = ebayCondition
        self.conditionDescription = conditionDescription
        self.itemSpecifics = itemSpecifics
        self.ebayCategoryId = ebayCategoryId
        self.returnPolicyId = returnPolicyId
        self.shippingPolicyId = shippingPolicyId
        self.paymentPolicyId = paymentPolicyId
        self.isDefault = isDefault
        self.sortOrder = sortOrder
    }
}

/// Editable working copy for the template editor. Strings use "" for "unset";
/// the service trims + nils them before sending so the server stores NULLs.
struct TemplateDraft: Equatable {
    var name: String = ""
    var descriptionTemplate: String = ""
    var ebayCondition: String = ""
    var conditionDescription: String = ""
    var ebayCategoryId: String = ""
    var returnPolicyId: String = ""
    var shippingPolicyId: String = ""
    var paymentPolicyId: String = ""
    var itemSpecifics: [String: String] = [:]
    var isDefault: Bool = false
    var sortOrder: Int = 0

    init() {}

    /// Pre-fill from an existing template for editing.
    init(from t: ListingTemplate) {
        name = t.name
        descriptionTemplate = t.descriptionTemplate ?? ""
        ebayCondition = t.ebayCondition ?? ""
        conditionDescription = t.conditionDescription ?? ""
        ebayCategoryId = t.ebayCategoryId ?? ""
        returnPolicyId = t.returnPolicyId ?? ""
        shippingPolicyId = t.shippingPolicyId ?? ""
        paymentPolicyId = t.paymentPolicyId ?? ""
        itemSpecifics = t.itemSpecifics
        isDefault = t.isDefault
        sortOrder = t.sortOrder
    }

    /// A template needs a name before it can be saved.
    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
