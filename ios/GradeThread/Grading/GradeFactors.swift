import SwiftUI

/// Shared grading domain model for the iOS certified-grade flow.
///
/// Mirrors the web app's `GRADE_FACTORS` / `GRADETHREAD_TIERS`
/// (`src/lib/constants.ts`) and the grade-pricing constants in the edge
/// service so the iOS surface speaks the same language as the rest of the
/// product. Kept tiny + value-typed so it's trivially testable.

// MARK: - Grading factors

/// The five weighted condition factors that compose an overall grade.
/// Weights sum to 1.0 and match `GRADE_FACTORS` exactly.
enum GradeFactor: String, CaseIterable, Identifiable {
    case fabricCondition
    case structuralIntegrity
    case cosmeticAppearance
    case functionalElements
    case odorCleanliness

    var id: String { rawValue }

    var label: String {
        switch self {
        case .fabricCondition:     return "Fabric Condition"
        case .structuralIntegrity: return "Structural Integrity"
        case .cosmeticAppearance:  return "Cosmetic Appearance"
        case .functionalElements:  return "Functional Elements"
        case .odorCleanliness:     return "Odor & Cleanliness"
        }
    }

    /// Contribution to the overall score. Rendered as a "(30%)" suffix.
    var weight: Double {
        switch self {
        case .fabricCondition:     return 0.30
        case .structuralIntegrity: return 0.25
        case .cosmeticAppearance:  return 0.20
        case .functionalElements:  return 0.15
        case .odorCleanliness:     return 0.10
        }
    }

    /// Pulls this factor's 1–10 sub-score out of a decoded report.
    func score(in report: GradeReportDTO) -> Double {
        switch self {
        case .fabricCondition:     return report.fabricConditionScore
        case .structuralIntegrity: return report.structuralIntegrityScore
        case .cosmeticAppearance:  return report.cosmeticAppearanceScore
        case .functionalElements:  return report.functionalElementsScore
        case .odorCleanliness:     return report.odorCleanlinessScore
        }
    }
}

// MARK: - Grade tiers

/// A grading service tier. Standard is covered by the plan's included
/// monthly bundle; premium/express debit grade credits. Economics mirror
/// `GRADETHREAD_TIERS` + `TIER_*` in the edge service.
enum GradeTierOption: String, CaseIterable, Identifiable {
    case standard
    case premium
    case express

    var id: String { rawValue }

    var label: String {
        switch self {
        case .standard: return "Standard"
        case .premium:  return "Premium"
        case .express:  return "Express"
        }
    }

    /// Turnaround SLA copy (matches `slaHours` in GRADETHREAD_TIERS).
    var turnaround: String {
        switch self {
        case .standard: return "~48 hr"
        case .premium:  return "~12 hr"
        case .express:  return "~1 hr"
        }
    }

    /// Grade credits consumed when not covered by an included Standard grade.
    var creditCost: Int {
        switch self {
        case .standard: return 1
        case .premium:  return 3
        case .express:  return 5
        }
    }

    /// One-line value prop for the picker.
    var blurb: String {
        switch self {
        case .standard: return "Full certified grade. Included with your plan."
        case .premium:  return "Faster queue for time-sensitive listings."
        case .express:  return "Top-priority — graded within the hour."
        }
    }
}

// MARK: - Score presentation

/// Shared score → color mapping so the ring, factor bars, and row badge all
/// agree. Follows the vault/20-domain/brand-design-system.md §3B grading tiers: Pristine/NWT (≥9.5) Emerald,
/// Excellent/NWOT (7.0–9.0) Steel Navy, Good/Fair (5.0–6.5) Amber, and
/// Poor/Damaged (<5.0) Crimson.
enum GradeScale {
    /// Confidence floor (inclusive) for a grade to certify automatically.
    /// Below this the grade is routed to a human reviewer server-side, so the
    /// app must treat it as provisional — not certified or shareable until
    /// review clears (US-1209, matches the CLAUDE.md grading spec: < 0.75 →
    /// human review). Kept here so the ring, confidence card, request flow, and
    /// list badge all agree on one threshold.
    static let gradeReviewConfidenceThreshold: Double = 0.75

    /// Whether a grade's confidence is low enough to require human review
    /// before it can be presented as certified/shareable.
    static func requiresReview(confidence: Double) -> Bool {
        confidence < gradeReviewConfidenceThreshold
    }

    /// Three bands, not four. Owner's decision 2026-09-04 (US-3010 AC6): a grade
    /// from 7.0 to 9.4 is GREEN. That band used to be Steel Navy here and on
    /// Android while the web drew it emerald, so the same garment was a
    /// different colour on a phone than on a laptop — and it is the ordinary
    /// band, where most resale garments land. The web's shape won.
    ///
    /// 7.0 is inclusive and matches the floor of "Very Good" in the web's
    /// `GRADE_TIER_BANDS`. Do not reach for `brandSteelNavy` here again: it is
    /// the primary SURFACE colour, so a grade drawn in it competes with the
    /// chrome around it and sat at 1.36:1 on Android's dark surface.
    static func color(for score: Double) -> Color {
        if score >= 7.0 { return .brandEmerald }
        if score >= 5.0 { return .brandAmber }
        return .brandRed
    }

    /// A per-tier SF Symbol so a grade's tier is distinguishable WITHOUT color
    /// (US-1281, Differentiate Without Color). Each band gets a visually
    /// distinct glyph — not one fixed seal: Pristine seal, Excellent
    /// checkmark-seal, Good/Fair a half-filled disc, Poor/Damaged a warning
    /// triangle.
    ///
    /// ⚠ THESE ARE FOUR BANDS AND ``color(for:)`` IS NOW THREE. That is
    /// deliberate, and this comment used to say they were "keyed to the same
    /// score bands". Since US-3010 collapsed 9.5+ and 7.0+ into one green band,
    /// the symbol is the only thing that still separates a 9.7 from a 7.2 —
    /// which is exactly the job it was added for. Do not collapse it to match.
    static func tierSymbol(for score: Double) -> String {
        if score >= 9.5 { return "seal.fill" }
        if score >= 7.0 { return "checkmark.seal.fill" }
        if score >= 5.0 { return "circle.bottomhalf.filled" }
        return "exclamationmark.triangle.fill"
    }

    /// Qualitative confidence bucket. Below ``gradeReviewConfidenceThreshold``
    /// routes to human review server-side, so we surface "Low" with a
    /// cautionary tone there.
    static func confidenceLabel(_ score: Double) -> (label: String, color: Color) {
        if score > 0.85 { return ("High", .brandEmerald) }
        if score >= gradeReviewConfidenceThreshold { return ("Medium", .brandAmber) }
        return ("Low", .brandRed)
    }
}

// MARK: - Certificate links

/// Builds the public, shareable certificate URL. Mirrors the web
/// `certificateUrl()` helper (`/cert/:id` on the marketing site). Prefers an
/// explicit server-provided URL when present so a future domain change there
/// flows through without an app update.
enum CertificateLink {
    /// The marketing/site origin that hosts public certificates.
    static let siteOrigin = URL(string: "https://gradethread.com")!

    static func url(certificateId: String) -> URL? {
        URL(string: "\(siteOrigin.absoluteString)/cert/\(certificateId)")
    }

    /// Resolve the best available certificate URL: a server-provided absolute
    /// URL wins; otherwise construct one from the certificate id.
    static func resolve(explicit: String?, certificateId: String?) -> URL? {
        if let explicit, let url = URL(string: explicit), url.scheme != nil {
            return url
        }
        if let certificateId { return url(certificateId: certificateId) }
        return nil
    }
}
