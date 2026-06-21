import Foundation

/// Garment Passport confidence taxonomy (US-1115 iOS parity) — mirrors the web
/// source of truth `src/lib/passport-confidence.ts` so the DB, edge, web, and
/// iOS never drift. There are exactly THREE levels, matching the
/// `garment_event_confidence` enum (00256).
///
/// Copy is deliberately measured (no "confirmed"/"guaranteed" on
/// probable/unknown) for legal safety. PURE + unit-tested; the view maps a
/// level → color/icon locally, exactly as the web page does.
enum PassportConfidence: String, Equatable {
    case deterministic
    case probable
    case unknown

    /// Coerce any stored confidence string to one of the three known levels.
    static func level(of raw: String?) -> PassportConfidence {
        switch raw {
        case "deterministic": return .deterministic
        case "probable": return .probable
        default: return .unknown
        }
    }

    /// Badge label shown to users.
    var label: String {
        switch self {
        case .deterministic: return "Verified"
        case .probable: return "Probable"
        case .unknown: return "Unverified"
        }
    }

    /// Tooltip / caption explaining the BASIS — measured wording, no over-claiming.
    var explanation: String {
        switch self {
        case .deterministic:
            return "Established by a first-party fact — a physical tag scan, an "
                + "owner-confirmed claim handoff, marketplace order lineage, or the "
                + "original grade itself."
        case .probable:
            return "Inferred from a visual fingerprint or reused-photo match. A "
                + "likely link in the chain — not an independently verified one."
        case .unknown:
            return "The basis for this link isn't independently verified (for "
                + "example, a self-declared origin)."
        }
    }
}

/// Aggregate chain-strength summary — "how many hops are proven vs. inferred".
/// Mirrors `chainStrength()` in the web taxonomy. PURE.
struct PassportChainStrength: Equatable {
    enum Label: String, Equatable {
        case strong = "Strong"
        case moderate = "Moderate"
        case emerging = "Emerging"
        case none = "None"
    }

    let total: Int
    let deterministic: Int
    let probable: Int
    let unknown: Int
    /// Fraction of links that are deterministic, [0, 1].
    let score: Double
    let label: Label
    /// One-line, legally-measured summary for the aggregate indicator.
    let summary: String

    init(confidences: [String?]) {
        var det = 0
        var prob = 0
        var unk = 0
        for c in confidences {
            switch PassportConfidence.level(of: c) {
            case .deterministic: det += 1
            case .probable: prob += 1
            case .unknown: unk += 1
            }
        }
        total = confidences.count
        deterministic = det
        probable = prob
        unknown = unk
        score = total == 0 ? 0 : Double(det) / Double(total)

        if total == 0 {
            label = .none
        } else if score >= 0.75 {
            label = .strong
        } else if score >= 0.4 {
            label = .moderate
        } else {
            label = .emerging
        }

        if total == 0 {
            summary = "No history recorded yet."
        } else {
            let linkWord = total == 1 ? "link is" : "links are"
            summary = "\(det) of \(total) \(linkWord) independently verified."
        }
    }
}
