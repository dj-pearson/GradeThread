import Foundation

/// Advanced, web-parity rule builder for the inventory list (US-1052).
///
/// Mirrors the web `src/lib/item-filter.ts` `FilterQuery` model: a list of
/// field/op/value rules combined with a single top-level AND/OR combinator.
/// Distinct from the fixed-facet ``InventoryFilterCriteria`` (which is AND
/// across facets, OR within a multi-select) — this layer is the "give me
/// *any* of these, or *all* of these" power tool resellers reach for when the
/// canned facets aren't expressive enough.
///
/// Pure value type with no SwiftUI dependency so the matching logic stays
/// unit-testable. Stored *inside* ``InventoryFilterCriteria`` so a saved
/// "smart view" carries its advanced rules along with its facets.
public struct InventoryRuleQuery: Codable, Equatable, Hashable {

    /// Top-level AND/OR. `and` = every rule must hold; `or` = any rule holds.
    public enum Combinator: String, Codable, CaseIterable, Identifiable, Hashable {
        case and
        case or

        public var id: String { rawValue }

        /// Reads naturally in the rule-builder header ("Match All of / Any of").
        public var label: String {
            switch self {
            case .and: return "All of"
            case .or:  return "Any of"
            }
        }
    }

    /// The item field a rule compares against. Subset of the web's
    /// `FilterField` restricted to values that exist on the local
    /// ``LocalInventoryItem`` cache (source is served by its own dedicated
    /// facet, which can resolve the human-readable source name).
    public enum Field: String, Codable, CaseIterable, Identifiable, Hashable {
        case brand
        case category
        case size
        case color
        // US-3124: who bought the item. Web calls it `sourced_by` and this is
        // the same column; `source` (where it came from) stays a facet, since
        // resolving an id to a name needs the source cache.
        case sourcedBy
        case sku
        case status
        case grade
        case cost
        case targetPrice
        case daysInStatus

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .brand:        return "Brand"
            case .category:     return "Category"
            case .size:         return "Size"
            case .color:        return "Color"
            case .sourcedBy:    return "Sourced by"
            case .sku:          return "SKU"
            case .status:       return "Status"
            case .grade:        return "Grade"
            case .cost:         return "Cost"
            case .targetPrice:  return "Target price"
            case .daysInStatus: return "Days in status"
            }
        }

        /// Numeric fields drive the operator set and value keyboard.
        public var isNumeric: Bool {
            switch self {
            case .grade, .cost, .targetPrice, .daysInStatus: return true
            default: return false
            }
        }
    }

    /// Comparison operator. Mirrors the web `FilterOp` set (with `in`/`nin`
    /// renamed to `anyOf`/`noneOf` and `isnull`/`notnull` to `isEmpty`/
    /// `notEmpty` to read better in a Swift UI).
    public enum Op: String, Codable, CaseIterable, Identifiable, Hashable {
        case eq
        case neq
        case contains
        case anyOf
        case noneOf
        case lt
        case gt
        case lte
        case gte
        case isEmpty
        case notEmpty

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .eq:       return "is"
            case .neq:      return "is not"
            case .contains: return "contains"
            case .anyOf:    return "is any of"
            case .noneOf:   return "is none of"
            case .lt:       return "<"
            case .gt:       return ">"
            case .lte:      return "≤"
            case .gte:      return "≥"
            case .isEmpty:  return "is empty"
            case .notEmpty: return "is not empty"
            }
        }

        /// `isEmpty`/`notEmpty` take no operand; everything else needs a value.
        public var requiresValue: Bool {
            switch self {
            case .isEmpty, .notEmpty: return false
            default: return true
            }
        }

        /// Operators offered for text vs numeric fields — mirrors the web's
        /// `TEXT_OPS` / `NUMERIC_OPS`.
        static let textOps: [Op] = [.eq, .neq, .contains, .anyOf, .noneOf, .isEmpty, .notEmpty]
        static let numericOps: [Op] = [.eq, .neq, .lt, .gt, .lte, .gte, .isEmpty, .notEmpty]
    }

    /// A single field/op/value clause. Intentionally *not* `Identifiable` via a
    /// stored UUID: the rule-builder UI keys rows by array offset, which keeps
    /// `Equatable`/`Codable` clean so two structurally-identical queries (one
    /// live, one saved) compare equal — that's what powers the "Saved" badge.
    public struct Rule: Codable, Equatable, Hashable {
        public var field: Field
        public var op: Op
        public var value: String

        public init(field: Field = .brand, op: Op = .eq, value: String = "") {
            self.field = field
            self.op = op
            self.value = value
        }

        /// A rule contributes to filtering only when it's fully specified: an
        /// operator that needs a value must have a non-blank one. Half-built
        /// rules (the user is mid-typing) are treated as no-ops rather than
        /// silently emptying the list.
        var isEffective: Bool {
            op.requiresValue
                ? !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                : true
        }
    }

    public var combinator: Combinator = .and
    public var rules: [Rule] = []

    public init(combinator: Combinator = .and, rules: [Rule] = []) {
        self.combinator = combinator
        self.rules = rules
    }

    public static let empty = InventoryRuleQuery()

    /// Rules that actually constrain the result set (see ``Rule/isEffective``).
    var effectiveRules: [Rule] { rules.filter(\.isEffective) }

    /// True when at least one effective rule is present.
    public var isActive: Bool { !effectiveRules.isEmpty }
}

// MARK: - Evaluation

extension InventoryRuleQuery {
    /// Evaluates the query against one item. An empty/all-no-op query matches
    /// everything (so it never narrows the list on its own). `internal`, not
    /// `public`, because ``LocalInventoryItem`` is a module-internal type.
    func matches(_ item: LocalInventoryItem, now: Date) -> Bool {
        let active = effectiveRules
        guard !active.isEmpty else { return true }
        switch combinator {
        case .and: return active.allSatisfy { $0.matches(item, now: now) }
        case .or:  return active.contains { $0.matches(item, now: now) }
        }
    }
}

extension InventoryRuleQuery.Rule {
    private static let dayInterval: TimeInterval = 86_400

    /// String value of a text field, or nil when absent.
    private func textValue(_ item: LocalInventoryItem) -> String? {
        switch field {
        case .brand:    return item.brand?.facetTrimmed
        case .category: return item.itemCategory?.facetTrimmed
        case .size:     return item.size?.facetTrimmed
        case .color:    return item.color?.facetTrimmed
        case .sourcedBy: return item.sourcedBy?.facetTrimmed
        case .sku:      return item.sku?.facetTrimmed
        case .status:   return item.status.facetTrimmed
        default:        return nil
        }
    }

    /// Numeric value of a numeric field, or nil when absent.
    private func numericValue(_ item: LocalInventoryItem, now: Date) -> Double? {
        switch field {
        case .grade:        return item.gradeValue
        case .cost:         return item.acquiredPrice
        case .targetPrice:  return item.targetPrice
        case .daysInStatus: return (now.timeIntervalSince(item.updatedAt) / Self.dayInterval).rounded(.down)
        default:            return nil
        }
    }

    func matches(_ item: LocalInventoryItem, now: Date) -> Bool {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)

        if field.isNumeric {
            let v = numericValue(item, now: now)
            switch op {
            case .isEmpty:  return v == nil
            case .notEmpty: return v != nil
            case .eq, .neq:
                guard let v, let n = Double(raw) else { return op == .neq ? v != nil : false }
                return op == .eq ? v == n : v != n
            case .lt, .gt, .lte, .gte:
                guard let v, let n = Double(raw) else { return false }
                switch op {
                case .lt:  return v < n
                case .gt:  return v > n
                case .lte: return v <= n
                default:   return v >= n
                }
            // Text operators don't apply to numeric fields.
            case .contains, .anyOf, .noneOf:
                return false
            }
        }

        let v = textValue(item)
        switch op {
        case .isEmpty:
            return v == nil
        case .notEmpty:
            return v != nil
        case .contains:
            guard let v else { return false }
            return v.lowercased().contains(raw.lowercased())
        case .eq, .neq:
            let equal = v != nil && v!.lowercased() == raw.lowercased()
            return op == .eq ? equal : !equal
        case .anyOf, .noneOf:
            let list = raw
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
                .filter { !$0.isEmpty }
            let hit = v != nil && list.contains(v!.lowercased())
            return op == .anyOf ? hit : !hit
        // Numeric operators don't apply to text fields.
        case .lt, .gt, .lte, .gte:
            return false
        }
    }
}
