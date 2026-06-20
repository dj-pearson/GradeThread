import Foundation

/// Plan-gate signals surfaced by the edge service (plan-gate.ts), decoded
/// centrally in ``EdgeAPI`` so every flipdesk / grading / AI call gets the same
/// upgrade-prompt + soft-warning behavior without per-call wiring (US-805).
///
/// Two shapes, mirroring the web (US-209 soft banner + US-210 upgrade dialog):
///   • a hard cap returns HTTP 402 with a JSON ``PlanGateError`` body, and
///   • an 80% soft-warn sets an `X-Plan-Warning` response header (``PlanWarning``).

// MARK: - 402 body

/// Decoded `402 PAYMENT_REQUIRED` body. Either a capacity cap (`CAP_REACHED`,
/// e.g. the active-listings limit) or a locked feature (`FEATURE_LOCKED`). The
/// JSON keys are emitted verbatim by plan-gate.ts (`requiredPlan` is camelCase),
/// so this decodes with a plain `JSONDecoder` (no key-conversion strategy).
struct PlanGateError: Decodable, Equatable, Identifiable, Sendable {
    /// `"CAP_REACHED"` | `"FEATURE_LOCKED"`.
    let error: String?
    /// Capacity kind for `CAP_REACHED` (activeListings / aiActions /
    /// includedGrades / marketplaces / teamSeats).
    let cap: String?
    let used: Int?
    let limit: Int?
    /// The user's current (effective) plan.
    let plan: String?
    /// The smallest plan that clears the gate.
    let requiredPlan: String?
    /// Feature key for `FEATURE_LOCKED`.
    let feature: String?

    /// Stable identity for `.sheet(item:)` — keyed on the gate's subject so the
    /// same cap doesn't churn the sheet, but a different cap can replace it.
    var id: String { "\(error ?? "PLAN")-\(cap ?? feature ?? "limit")" }

    var isFeatureLock: Bool { error == "FEATURE_LOCKED" }

    /// Sheet title, e.g. "You've reached your active-listings limit".
    var title: String {
        if isFeatureLock { return "That's a paid feature" }
        return "You've reached your \(capLabel) limit"
    }

    /// One-line usage detail, e.g. "10 of 10 used this month". Nil when the body
    /// didn't carry usage numbers (feature locks don't).
    var usageDetail: String? {
        guard let limit, !isFeatureLock else { return nil }
        let used = used ?? limit
        return "\(used) of \(limit) used this month"
    }

    /// Recommendation line, e.g. "Upgrade to Pro to keep going".
    var recommendation: String {
        guard let tier = recommendedTierLabel else {
            return "Upgrade your plan to keep going."
        }
        return "Upgrade to \(tier) to keep going."
    }

    /// Pretty-cased recommended tier (e.g. "Pro"), nil when not provided.
    var recommendedTierLabel: String? {
        requiredPlan.map(Self.prettyPlan)
    }

    /// Human label for the capacity kind.
    var capLabel: String {
        Self.capLabel(cap)
    }

    static func capLabel(_ cap: String?) -> String {
        switch cap {
        case "activeListings": return "active-listings"
        case "aiActions": return "AI-actions"
        case "includedGrades": return "monthly-grades"
        case "marketplaces": return "marketplace"
        case "teamSeats": return "team-seat"
        default: return "plan"
        }
    }

    static func prettyPlan(_ raw: String) -> String {
        raw.split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// Promote a soft ``PlanWarning`` into a cap-reached gate so the same
    /// upgrade prompt can present it. The warning carries no recommended tier,
    /// so the prompt falls back to generic upgrade copy.
    init(fromWarning warning: PlanWarning) {
        self.error = "CAP_REACHED"
        self.cap = warning.kind
        self.used = warning.used
        self.limit = warning.limit
        self.plan = nil
        self.requiredPlan = nil
        self.feature = nil
    }

    /// Best-effort decode of a 402 body. Returns nil when the body isn't a
    /// recognizable plan-gate payload (so the caller can fall through to its
    /// normal error handling).
    static func decode(from data: Data) -> PlanGateError? {
        guard let gate = try? JSONDecoder().decode(PlanGateError.self, from: data),
              gate.error == "CAP_REACHED" || gate.error == "FEATURE_LOCKED" else {
            return nil
        }
        return gate
    }
}

// MARK: - X-Plan-Warning header

/// Parsed `X-Plan-Warning` response header, emitted by the edge at the 80%
/// soft-warn threshold. Wire format (plan-gate.ts):
/// `CAP_80;kind=activeListings;used=8;limit=10`.
struct PlanWarning: Equatable, Identifiable, Sendable {
    let kind: String
    let used: Int
    let limit: Int

    /// Identity for `.task(id:)` auto-dismiss + de-duping the banner.
    var id: String { "\(kind)-\(used)-\(limit)" }

    /// Fraction of the cap consumed (0...1+). `limit <= 0` ⇒ 0 (unlimited / N/A).
    var pct: Double {
        guard limit > 0 else { return 0 }
        return Double(used) / Double(limit)
    }

    /// Whole-percent usage for display (e.g. 80).
    var pctWhole: Int { Int((pct * 100).rounded()) }

    var capLabel: String { PlanGateError.capLabel(kind) }

    /// Parses the `CAP_80;kind=…;used=…;limit=…` header. Returns nil for an
    /// unrecognized shape so a malformed header is simply ignored.
    init?(header: String) {
        var fields: [String: String] = [:]
        for part in header.split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1).map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            guard kv.count == 2 else { continue }
            fields[kv[0]] = kv[1]
        }
        guard let kind = fields["kind"],
              let used = fields["used"].flatMap({ Int($0) }),
              let limit = fields["limit"].flatMap({ Int($0) }) else {
            return nil
        }
        self.kind = kind
        self.used = used
        self.limit = limit
    }
}

// MARK: - Usage-alert threshold (mirrors web US-209)

/// The configured soft-warning sensitivity. The edge only emits the header at
/// ≥80%, so this can make the banner *stricter* (suppress until 95%) but never
/// looser than the server's floor. Persisted in ``AppPreferences``.
enum UsageAlertThreshold: Int, CaseIterable, Identifiable {
    case fifty = 50
    case eighty = 80
    case ninetyFive = 95

    var id: Int { rawValue }
    var fraction: Double { Double(rawValue) / 100 }
    var label: String { "\(rawValue)%" }
}
