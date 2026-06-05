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
/// agree. Matches the web thresholds (>7 green, ≥5 amber, else red).
enum GradeScale {
    static func color(for score: Double) -> Color {
        if score > 7 { return .green }
        if score >= 5 { return .orange }
        return .brandRed
    }

    /// Qualitative confidence bucket. Below 0.75 routes to human review
    /// server-side, so we surface "Low" with a cautionary tone there.
    static func confidenceLabel(_ score: Double) -> (label: String, color: Color) {
        if score > 0.85 { return ("High", .green) }
        if score >= 0.75 { return ("Medium", .orange) }
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
