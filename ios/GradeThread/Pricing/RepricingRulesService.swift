import Foundation

/// Edge client for repricing automation rules (US-672). Uses `EdgeAPI.shared`
/// (token, snake_case ⇄ camelCase, JSON). Rules carry only scalar fields, so the
/// snake_case conversion is safe here (unlike templates' free-form map). Behind a
/// protocol so ``RepricingRulesStore`` is unit-testable with a fake.
protocol RepricingRulesProviding {
    func list() async throws -> [RepricingRule]
    func create(_ draft: RuleDraft) async throws -> RepricingRule
    func update(id: String, _ draft: RuleDraft) async throws -> RepricingRule
    func delete(id: String) async throws
    /// Run the caller's rules now; returns the run counts.
    func run() async throws -> RuleRunResult
    /// Recent automatic price changes (the applied-changes feed).
    func actions() async throws -> [RepricingAction]
}

struct RepricingRulesService: RepricingRulesProviding {
    private let api: EdgeAPI
    init(api: EdgeAPI = .shared) { self.api = api }

    private static let base = "/api/flipdesk/pricing/rules"

    private struct Body: Encodable {
        let name: String
        let enabled: Bool
        let inventoryItemId: String?
        let filterBrand: String?
        let filterCategoryId: String?
        let minAgeDays: Int
        let dropPct: Double
        let intervalDays: Int
        let floorPriceCents: Int?
        let autoAcceptConfidence: Double?

        init(_ d: RuleDraft) {
            func nilIfBlank(_ s: String) -> String? {
                let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                return t.isEmpty ? nil : t
            }
            name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
            enabled = d.enabled
            inventoryItemId = d.inventoryItemId
            filterBrand = nilIfBlank(d.filterBrand)
            filterCategoryId = nilIfBlank(d.filterCategoryId)
            minAgeDays = max(0, d.minAgeDays)
            dropPct = d.dropPct
            intervalDays = max(1, d.intervalDays)
            floorPriceCents = d.floorPriceCents
            autoAcceptConfidence = d.autoAcceptEnabled ? d.autoAcceptConfidence : nil
        }
    }

    private struct OkResponse: Decodable { let ok: Bool }

    func list() async throws -> [RepricingRule] {
        let res: RepricingRulesResponse = try await api.getJSON(Self.base)
        return res.rules
    }

    func create(_ draft: RuleDraft) async throws -> RepricingRule {
        let res: RepricingRuleResponse = try await api.postJSON(Self.base, body: Body(draft))
        return res.rule
    }

    func update(id: String, _ draft: RuleDraft) async throws -> RepricingRule {
        let res: RepricingRuleResponse = try await api.putJSON("\(Self.base)/\(id)", body: Body(draft))
        return res.rule
    }

    func delete(id: String) async throws {
        let _: OkResponse = try await api.deleteJSON("\(Self.base)/\(id)")
    }

    func run() async throws -> RuleRunResult {
        struct Empty: Encodable {}
        return try await api.postJSON("\(Self.base)/run", body: Empty())
    }

    func actions() async throws -> [RepricingAction] {
        let res: RepricingActionsResponse = try await api.getJSON("\(Self.base)/actions")
        return res.actions
    }
}
