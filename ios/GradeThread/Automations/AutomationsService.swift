import Foundation

/// Edge client for the general FlipDesk Automations rules (US-1135). Hits the
/// same `/api/flipdesk/automations/*` endpoints the web Automations page uses,
/// through `EdgeAPI.shared` (token + snake_case ⇄ camelCase + JSON). Behind a
/// protocol so ``AutomationsStore`` is unit-testable with a fake.
protocol AutomationsProviding {
    func list() async throws -> [AutomationRule]
    func create(_ input: AutomationRuleInput) async throws -> AutomationRule
    func update(id: String, _ input: AutomationRuleInput) async throws -> AutomationRule
    /// US-1267: minimal partial update of a rule's enablement — a `{isActive}`
    /// PATCH that touches ONLY that field, so a toggle can't clobber a concurrent
    /// edit (or server-managed fields) the way the full-replace PUT would.
    func setActive(id: String, isActive: Bool) async throws -> AutomationRule
    func delete(id: String) async throws
    /// Run the caller's active rules now; returns the run counts.
    func run() async throws -> AutomationRunResult
    /// Preview which listings a single rule would touch right now (applies nothing).
    func dryRun(id: String) async throws -> AutomationDryRunResult
    /// The recent actions a rule has applied (its activity log).
    func actions(id: String) async throws -> [AutomationActionRow]
}

struct AutomationsService: AutomationsProviding {
    private let api: EdgeAPI
    init(api: EdgeAPI = .shared) { self.api = api }

    private static let base = "/api/flipdesk/automations"

    private struct Empty: Encodable {}
    private struct OkResponse: Decodable { let ok: Bool }
    /// Minimal toggle payload (encodes to `{"is_active": …}` via EdgeAPI's
    /// convertToSnakeCase encoder).
    private struct ActivePatch: Encodable { let isActive: Bool }

    func list() async throws -> [AutomationRule] {
        let res: AutomationRulesResponse = try await api.getJSON("\(Self.base)/rules")
        return res.rules
    }

    func create(_ input: AutomationRuleInput) async throws -> AutomationRule {
        let res: AutomationRuleResponse = try await api.postJSON("\(Self.base)/rules", body: input)
        return res.rule
    }

    func update(id: String, _ input: AutomationRuleInput) async throws -> AutomationRule {
        let res: AutomationRuleResponse = try await api.putJSON("\(Self.base)/rules/\(id)", body: input)
        return res.rule
    }

    func setActive(id: String, isActive: Bool) async throws -> AutomationRule {
        let res: AutomationRuleResponse = try await api.patchJSON(
            "\(Self.base)/rules/\(id)", body: ActivePatch(isActive: isActive)
        )
        return res.rule
    }

    func delete(id: String) async throws {
        let _: OkResponse = try await api.deleteJSON("\(Self.base)/rules/\(id)")
    }

    func run() async throws -> AutomationRunResult {
        try await api.postJSON("\(Self.base)/run", body: Empty())
    }

    func dryRun(id: String) async throws -> AutomationDryRunResult {
        try await api.postJSON("\(Self.base)/rules/\(id)/dry-run", body: Empty())
    }

    func actions(id: String) async throws -> [AutomationActionRow] {
        let res: AutomationActionsResponse = try await api.getJSON("\(Self.base)/rules/\(id)/actions")
        return res.actions
    }
}
