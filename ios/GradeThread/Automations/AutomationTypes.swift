import Foundation

/// Wire types for the general FlipDesk Automations surface (US-1135) — the
/// trigger → action → scope rules edited on the web Automations page
/// (`/api/flipdesk/automations/*`), distinct from the repricing rules
/// (US-672, `/api/flipdesk/pricing/rules`).
///
/// All of these round-trip through `EdgeAPI`'s symmetric snake_case ⇄ camelCase
/// strategy: camelCase Swift property names encode to the snake_case keys the
/// edge `normalizeAutomationInput` expects, and decode back from them — including
/// the nested `trigger_json` / `action_json` / `scope_json` jsonb columns, whose
/// inner keys (`cooldown_days`, `margin_floor_pct`, …) convert the same way.

// MARK: - Trigger / action / scope

/// When a rule fires. `watchers` is present only for `watchers_lt_after_days`.
struct AutomationTrigger: Codable, Equatable, Hashable {
    var type: String          // days_listed_gt | no_views_in_days | watchers_lt_after_days
    var days: Int
    var cooldownDays: Int
    var watchers: Int?
}

/// What a fired rule does. `pct` applies to drop/promo; `marginFloorPct` to drop.
struct AutomationAction: Codable, Equatable, Hashable {
    var type: String          // price_drop_pct | set_promo_rate_pct | end_listing
    var pct: Double?
    var marginFloorPct: Int?
}

/// One scope filter clause (mirrors the US-143 FilterQuery rule shape).
struct AutomationScopeRule: Codable, Equatable, Hashable {
    var field: String         // brand | category | size | source | cost | target_price | status | grade | days_in_status
    var op: String            // eq | neq | lt | gt | lte | gte | in | nin | contains | isnull | notnull
    var value: String
}

/// Which listings a rule applies to: every active listing, or a filtered subset.
struct AutomationScope: Codable, Equatable, Hashable {
    var type: String          // all | filter
    var combinator: String?   // and | or  (filter only)
    var rules: [AutomationScopeRule]?
}

// MARK: - Rule

/// A stored automation rule, decoded from the edge.
struct AutomationRule: Identifiable, Decodable, Equatable, Hashable {
    let id: String
    var name: String
    var triggerJson: AutomationTrigger
    var actionJson: AutomationAction
    var scopeJson: AutomationScope
    var isActive: Bool
    var lastRunAt: String?
    var createdAt: String?

    var lastRun: Date? { lastRunAt.flatMap(AutomationDate.parse) }

    /// e.g. "listed more than 30 days".
    var triggerSummary: String {
        switch triggerJson.type {
        case "no_views_in_days":
            return "no views after \(triggerJson.days) days"
        case "watchers_lt_after_days":
            return "fewer than \(triggerJson.watchers ?? 0) watchers after \(triggerJson.days) days"
        default:
            return "listed more than \(triggerJson.days) days"
        }
    }

    /// e.g. "drop price 10%" / "end the listing".
    var actionSummary: String {
        switch actionJson.type {
        case "set_promo_rate_pct":
            return "set promo rate to \(AutomationFormat.pct(actionJson.pct ?? 0))%"
        case "end_listing":
            return "end the listing"
        default:
            return "drop price \(AutomationFormat.pct(actionJson.pct ?? 0))%"
        }
    }

    /// Short label for the action kind, used as a badge.
    var actionLabel: String {
        switch actionJson.type {
        case "set_promo_rate_pct": return "Promo rate"
        case "end_listing": return "End listing"
        default: return "Price drop"
        }
    }

    /// e.g. "All active listings" / "Filtered (2)".
    var scopeSummary: String {
        guard scopeJson.type == "filter", let rules = scopeJson.rules, !rules.isEmpty else {
            return "All active listings"
        }
        return "Filtered (\(rules.count))"
    }
}

// MARK: - Editor draft

/// Editable working copy for the rule editor. Converts to the snake_case wire
/// input on save.
struct AutomationDraft: Equatable {
    var name = ""
    var isActive = true
    // Trigger
    var triggerType = "days_listed_gt"
    var triggerDays = 30
    var triggerWatchers = 2
    var cooldownDays = 7
    // Action
    var actionType = "price_drop_pct"
    var actionPct = 10.0
    var marginFloorPct = 10
    // Scope
    var scopeMode = "all"     // all | filter
    var combinator = "and"    // and | or
    var scopeRules: [ScopeRuleDraft] = []

    init() {}

    init(from r: AutomationRule) {
        name = r.name
        isActive = r.isActive
        triggerType = r.triggerJson.type
        triggerDays = max(1, r.triggerJson.days)
        triggerWatchers = r.triggerJson.watchers ?? 2
        cooldownDays = max(1, r.triggerJson.cooldownDays)
        actionType = r.actionJson.type
        actionPct = r.actionJson.pct ?? 10
        marginFloorPct = r.actionJson.marginFloorPct ?? 10
        if r.scopeJson.type == "filter", let rules = r.scopeJson.rules, !rules.isEmpty {
            scopeMode = "filter"
            combinator = r.scopeJson.combinator ?? "and"
            scopeRules = rules.map { ScopeRuleDraft(field: $0.field, op: $0.op, value: $0.value) }
        }
    }

    private var needsPct: Bool { actionType != "end_listing" }

    /// A rule needs a name and a valid action percent (none for end_listing).
    var isValid: Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if !needsPct { return true }
        return actionPct >= 1
    }

    var triggerJson: AutomationTrigger {
        let days = max(1, triggerDays)
        let cooldown = max(1, cooldownDays)
        if triggerType == "watchers_lt_after_days" {
            return AutomationTrigger(type: triggerType, days: days, cooldownDays: cooldown, watchers: max(1, triggerWatchers))
        }
        return AutomationTrigger(type: triggerType, days: days, cooldownDays: cooldown, watchers: nil)
    }

    var actionJson: AutomationAction {
        switch actionType {
        case "set_promo_rate_pct":
            return AutomationAction(type: actionType, pct: actionPct, marginFloorPct: nil)
        case "end_listing":
            return AutomationAction(type: "end_listing", pct: nil, marginFloorPct: nil)
        default:
            return AutomationAction(type: "price_drop_pct", pct: actionPct, marginFloorPct: max(0, marginFloorPct))
        }
    }

    var scopeJson: AutomationScope {
        let rules = scopeRules.compactMap { rule -> AutomationScopeRule? in
            let value = rule.value.trimmingCharacters(in: .whitespacesAndNewlines)
            // Null/not-null operators take no value; everything else needs one.
            let valueless = rule.op == "isnull" || rule.op == "notnull"
            guard valueless || !value.isEmpty else { return nil }
            return AutomationScopeRule(field: rule.field, op: rule.op, value: value)
        }
        if scopeMode == "filter", !rules.isEmpty {
            return AutomationScope(type: "filter", combinator: combinator, rules: rules)
        }
        return AutomationScope(type: "all", combinator: nil, rules: nil)
    }

    func buildInput() -> AutomationRuleInput {
        AutomationRuleInput(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            isActive: isActive,
            triggerJson: triggerJson,
            actionJson: actionJson,
            scopeJson: scopeJson
        )
    }
}

/// A single editable scope clause (carries a stable id for SwiftUI `ForEach`).
struct ScopeRuleDraft: Identifiable, Equatable {
    let id = UUID()
    var field = "brand"
    var op = "eq"
    var value = ""
}

/// Create/update payload (snake_case wire shape via EdgeAPI's encoder).
struct AutomationRuleInput: Encodable {
    let name: String
    let isActive: Bool
    let triggerJson: AutomationTrigger
    let actionJson: AutomationAction
    let scopeJson: AutomationScope
}

// MARK: - Dry run

/// One listing a dry run reports the rule would touch (applies nothing).
struct AutomationDryRunMatch: Identifiable, Decodable, Equatable {
    let listingId: String
    let title: String?
    let actionType: String
    let currentPriceCents: Int
    let newPriceCents: Int?
    let currentPromoRatePct: Int?
    let newPromoRatePct: Int?
    let floored: Bool

    var id: String { listingId }
    var displayTitle: String { title?.nilIfBlank ?? "Untitled item" }
}

struct AutomationDryRunResult: Decodable {
    let listingsScanned: Int?
    let affected: [AutomationDryRunMatch]?

    var scanned: Int { listingsScanned ?? 0 }
    var matches: [AutomationDryRunMatch] { affected ?? [] }
}

// MARK: - Activity log

/// Free-form before/after detail captured on an applied action.
struct AutomationActionDetail: Decodable, Equatable {
    let priceCents: Int?
    let promoRatePct: Int?
    let listingStatus: String?
}

/// One action a rule applied (the per-rule activity feed).
struct AutomationActionRow: Identifiable, Decodable, Equatable {
    let id: String
    let actionType: String
    let beforeJson: AutomationActionDetail?
    let afterJson: AutomationActionDetail?
    let ebaySynced: Bool
    let createdAt: String?
    let inventoryItems: ItemRef?

    struct ItemRef: Decodable, Equatable {
        let title: String?
        let brand: String?
    }

    var created: Date? { createdAt.flatMap(AutomationDate.parse) }
    var displayTitle: String { inventoryItems?.title?.nilIfBlank ?? "Untitled item" }
}

// MARK: - Run result

/// Result of an on-demand run. Counts are optional so the feature-disabled shape
/// (`{ ok:false, skipped:true }`) still decodes.
struct AutomationRunResult: Decodable {
    let ok: Bool
    let applied: Int?
    let listingsScanned: Int?
    let errors: Int?
    let skipped: Bool?
    let reason: String?

    var appliedCount: Int { applied ?? 0 }
    var scannedCount: Int { listingsScanned ?? 0 }
}

// MARK: - Responses

struct AutomationRulesResponse: Decodable { let rules: [AutomationRule] }
struct AutomationRuleResponse: Decodable { let rule: AutomationRule }
struct AutomationActionsResponse: Decodable { let actions: [AutomationActionRow] }

// MARK: - Formatting helpers

enum AutomationFormat {
    /// Trim a whole-number percent ("10" not "10.0"); keep one decimal otherwise.
    static func pct(_ p: Double) -> String {
        p == p.rounded() ? String(Int(p)) : String(format: "%.1f", p)
    }
    static func money(_ cents: Int) -> String {
        String(format: "$%.2f", Double(cents) / 100)
    }
}

/// Lenient ISO-8601 parser (handles PostgREST's fractional seconds).
enum AutomationDate {
    static func parse(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: raw) { return d }
        return ISO8601DateFormatter().date(from: raw)
    }
}

// MARK: - Vocabulary (editor pickers)

enum AutomationVocabulary {
    static let triggerTypes: [(value: String, label: String)] = [
        ("days_listed_gt", "Listed more than…"),
        ("no_views_in_days", "No views after…"),
        ("watchers_lt_after_days", "Few watchers after…"),
    ]

    static let actionTypes: [(value: String, label: String)] = [
        ("price_drop_pct", "Drop price by %"),
        ("set_promo_rate_pct", "Set promo rate %"),
        ("end_listing", "End the listing"),
    ]

    static let scopeFields: [(value: String, label: String)] = [
        ("brand", "Brand"),
        ("category", "Category"),
        ("size", "Size"),
        ("source", "Source"),
        ("cost", "Cost"),
        ("target_price", "Target price"),
        ("status", "Status"),
        ("grade", "Grade"),
        ("days_in_status", "Days in status"),
    ]

    static let scopeOps: [(value: String, label: String)] = [
        ("eq", "is"),
        ("neq", "is not"),
        ("contains", "contains"),
        ("in", "is any of"),
        ("nin", "is none of"),
        ("gt", ">"),
        ("gte", "≥"),
        ("lt", "<"),
        ("lte", "≤"),
        ("isnull", "is empty"),
        ("notnull", "is set"),
    ]

    static func fieldLabel(_ value: String) -> String {
        scopeFields.first { $0.value == value }?.label ?? value
    }
    static func opLabel(_ value: String) -> String {
        scopeOps.first { $0.value == value }?.label ?? value
    }
}
