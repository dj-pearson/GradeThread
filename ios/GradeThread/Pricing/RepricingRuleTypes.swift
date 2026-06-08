import Foundation

/// A repricing automation rule (US-672). Decoded from the edge via EdgeAPI's
/// convertFromSnakeCase strategy, so property names are camelCase counterparts
/// of the snake_case columns. Timestamps decode as raw strings (parsed lazily)
/// to dodge the shared decoder's strict ISO-8601 (PostgREST emits fractional
/// seconds the .iso8601 strategy rejects).
struct RepricingRule: Identifiable, Decodable, Equatable, Hashable {
    let id: String
    var name: String
    var enabled: Bool
    var inventoryItemId: String?
    var filterBrand: String?
    var filterCategoryId: String?
    var minAgeDays: Int
    var dropPct: Double
    var intervalDays: Int
    var floorPriceCents: Int?
    var autoAcceptConfidence: Double?
    var lastRunAt: String?

    var lastRun: Date? { lastRunAt.flatMap(RepricingDate.parse) }

    /// One-line human summary of the action, e.g. "Drop 10% every 7 days · floor $9.99".
    var actionSummary: String {
        var parts: [String] = []
        if dropPct > 0 {
            parts.append("Drop \(Self.trimPct(dropPct))% every \(intervalDays)d")
        }
        if let conf = autoAcceptConfidence {
            parts.append("auto-accept ≥ \(Int((conf * 100).rounded()))%")
        }
        if let floor = floorPriceCents {
            parts.append("floor \(Self.dollars(floor))")
        }
        return parts.isEmpty ? "No effect" : parts.joined(separator: " · ")
    }

    /// One-line scope summary, e.g. "Nike · cat 11450 · 30d+ old" or "All listings".
    var scopeSummary: String {
        var parts: [String] = []
        if inventoryItemId != nil { parts.append("One item") }
        if let b = filterBrand, !b.isEmpty { parts.append(b) }
        if let cat = filterCategoryId, !cat.isEmpty { parts.append("cat \(cat)") }
        if minAgeDays > 0 { parts.append("\(minAgeDays)d+ old") }
        return parts.isEmpty ? "All listings" : parts.joined(separator: " · ")
    }

    static func trimPct(_ p: Double) -> String {
        p == p.rounded() ? String(Int(p)) : String(format: "%.1f", p)
    }
    static func dollars(_ cents: Int) -> String {
        String(format: "$%.2f", Double(cents) / 100)
    }
}

/// Editable working copy for the rule editor. Floor price is entered in dollars
/// and converted to cents on save.
struct RuleDraft: Equatable {
    var name: String = ""
    var enabled: Bool = true
    var inventoryItemId: String? = nil
    var filterBrand: String = ""
    var filterCategoryId: String = ""
    var minAgeDays: Int = 0
    var dropPct: Double = 10
    var intervalDays: Int = 7
    var floorPrice: String = ""        // dollars text
    var autoAcceptEnabled: Bool = false
    var autoAcceptConfidence: Double = 0.8

    init() {}

    init(from r: RepricingRule) {
        name = r.name
        enabled = r.enabled
        inventoryItemId = r.inventoryItemId
        filterBrand = r.filterBrand ?? ""
        filterCategoryId = r.filterCategoryId ?? ""
        minAgeDays = r.minAgeDays
        dropPct = r.dropPct
        intervalDays = r.intervalDays
        floorPrice = r.floorPriceCents.map { String(format: "%.2f", Double($0) / 100) } ?? ""
        autoAcceptEnabled = r.autoAcceptConfidence != nil
        autoAcceptConfidence = r.autoAcceptConfidence ?? 0.8
    }

    /// A rule needs a name and an actual effect (a drop or auto-accept).
    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (dropPct > 0 || autoAcceptEnabled)
    }

    /// Floor price text → cents, or nil when blank/unparseable.
    var floorPriceCents: Int? {
        let t = floorPrice.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let dollars = Double(t), dollars >= 0 else { return nil }
        return Int((dollars * 100).rounded())
    }
}

/// One automatic price change a rule applied (US-672) — the "applied changes" feed.
struct RepricingAction: Identifiable, Decodable, Equatable {
    let id: String
    let ruleId: String?
    let listingId: String?
    let oldPriceCents: Int
    let newPriceCents: Int
    let reason: String
    let ebaySynced: Bool
    let createdAt: String?
    let inventoryItems: ItemRef?

    struct ItemRef: Decodable, Equatable {
        let title: String?
        let brand: String?
    }

    var created: Date? { createdAt.flatMap(RepricingDate.parse) }
    var title: String { inventoryItems?.title?.nilIfBlank ?? "Item" }
    var oldDollars: Double { Double(oldPriceCents) / 100 }
    var newDollars: Double { Double(newPriceCents) / 100 }
    var reasonLabel: String {
        switch reason {
        case "auto_accept": return "Auto-accepted comp"
        case "scheduled_markdown": return "Scheduled markdown"
        default: return reason
        }
    }
}

struct RepricingRulesResponse: Decodable { let rules: [RepricingRule] }
struct RepricingRuleResponse: Decodable { let rule: RepricingRule }
struct RepricingActionsResponse: Decodable { let actions: [RepricingAction] }

/// Result of an on-demand rules run. Counts are optional so the
/// feature-disabled shape (`{ ok:false, skipped:true }`) still decodes.
struct RuleRunResult: Decodable {
    let ok: Bool
    let applied: Int?
    let listingsScanned: Int?
    let rulesEvaluated: Int?
    let skipped: Int?
    let reason: String?

    var appliedCount: Int { applied ?? 0 }
    var scannedCount: Int { listingsScanned ?? 0 }
}

// Custom decoding lives in an extension so the synthesized memberwise
// initializer (used by tests) is preserved.
extension RuleRunResult {
    enum CodingKeys: String, CodingKey {
        case ok, applied, listingsScanned, rulesEvaluated, skipped, reason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        let applied = try c.decodeIfPresent(Int.self, forKey: .applied)
        let listingsScanned = try c.decodeIfPresent(Int.self, forKey: .listingsScanned)
        let rulesEvaluated = try c.decodeIfPresent(Int.self, forKey: .rulesEvaluated)
        // `skipped` is a count on a normal run but a Bool flag when the feature
        // is disabled ({"skipped":true}); accept either, keeping only the count.
        let skipped = try? c.decode(Int.self, forKey: .skipped)
        let reason = try c.decodeIfPresent(String.self, forKey: .reason)
        self.init(
            ok: ok,
            applied: applied,
            listingsScanned: listingsScanned,
            rulesEvaluated: rulesEvaluated,
            skipped: skipped,
            reason: reason
        )
    }
}

/// Lenient ISO-8601 parser shared by the rule types (handles fractional seconds).
enum RepricingDate {
    static func parse(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: raw) { return d }
        return ISO8601DateFormatter().date(from: raw)
    }
}
