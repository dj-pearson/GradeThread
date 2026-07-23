import Foundation

/// Why a user thinks a certified grade is wrong. Mirrors `DISPUTE_REASONS`
/// in the web app (`src/lib/constants.ts`) — same `value`s so disputes filed
/// from iOS read identically in the admin queue.
enum DisputeReason: String, CaseIterable, Identifiable {
    case gradeTooLow = "grade_too_low"
    case designAsDamage = "design_as_damage"
    case defectNotPresent = "defect_not_present"
    case missedDetail = "missed_detail"
    case wrongCategory = "wrong_category"
    case factorScore = "factor_score"
    case other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .gradeTooLow:      return "Overall grade is too low"
        case .designAsDamage:   return "Intentional design counted as damage"
        case .defectNotPresent: return "A listed defect isn't actually present"
        case .missedDetail:     return "An important detail or flaw was missed"
        case .wrongCategory:    return "Wrong garment type or category"
        case .factorScore:      return "A factor score looks wrong"
        case .other:            return "Other (please explain)"
        }
    }
}

/// Composes the stored `disputes.reason` string from the chosen category +
/// optional free-text. Mirrors the web's composition exactly so the record
/// is consistent across surfaces.
enum DisputeComposer {
    /// Minimum free-text length when "Other" is chosen.
    static let otherMinLength = 20

    static func compose(reason: DisputeReason, details: String) -> String {
        let trimmed = details.trimmingCharacters(in: .whitespacesAndNewlines)
        if reason == .other { return trimmed }
        if trimmed.isEmpty { return reason.label }
        return "\(reason.label) — \(trimmed)"
    }

    /// Whether the form is submittable: "Other" needs a real explanation,
    /// the rest are fine with just the category.
    static func canSubmit(reason: DisputeReason, details: String) -> Bool {
        guard reason == .other else { return true }
        return details.trimmingCharacters(in: .whitespacesAndNewlines).count >= otherMinLength
    }
}

/// The window in which a grade can still be disputed. The SERVER
/// (grade.ts DISPUTE_WINDOW_DAYS, US-2153) is the source of truth and now
/// rejects an out-of-window filing with a typed DISPUTE_WINDOW_EXPIRED error;
/// this local copy only decides whether to show the affordance and must stay
/// equal to it. An unparseable/absent timestamp is treated as open so we never
/// wrongly hide the action.
enum GradeDisputeWindow {
    static let days = 7

    static func isOpen(createdAt: String?, now: Date = .now, calendar: Calendar = .current) -> Bool {
        guard let createdAt, let created = parseISO(createdAt) else { return true }
        guard let cutoff = calendar.date(byAdding: .day, value: -days, to: now) else { return true }
        return created >= cutoff
    }

    private static func parseISO(_ string: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}
