import SwiftUI

/// US-819: maps a stored `disputes.status` value to grade-row badge
/// presentation, so the Grades list can show dispute state (open / under
/// review / resolved) without spelunking into each item's report. The label +
/// `isDisputed` mapping is pure (no SwiftData / network) so it's unit-testable;
/// the tone/icon are for the badge view.
///
/// Status values mirror the server `dispute_status` enum (00001):
/// `open` / `under_review` / `resolved` / `rejected`.
enum DisputeStatusDisplay {

    /// Whether a stored status string represents a dispute worth badging on a
    /// grade row. An unknown/empty value is treated as "no dispute" so a future
    /// enum value never renders a blank capsule.
    static func isDisputed(_ status: String?) -> Bool {
        guard let status else { return false }
        return label(for: status) != nil
    }

    /// Short row-badge label, or nil for an unknown/empty status.
    static func label(for status: String) -> String? {
        switch status {
        case "open":         return "Disputed"
        case "under_review": return "Under review"
        case "resolved":     return "Dispute resolved"
        case "rejected":     return "Dispute declined"
        default:             return nil
        }
    }

    /// VoiceOver-friendly description for the badge.
    static func accessibilityLabel(for status: String) -> String {
        label(for: status).map { "Grade dispute: \($0)" } ?? "Grade dispute"
    }

    /// Badge tint. Open/under-review read as in-progress amber; a resolved
    /// dispute reads emerald (settled in the seller's favor or closed); a
    /// declined dispute reads neutral.
    static func tone(for status: String) -> Color {
        switch status {
        case "open", "under_review": return .brandAmber
        case "resolved":             return .brandEmerald
        default:                     return .secondary
        }
    }

    /// Non-color shape signal (WCAG 1.4.1) so the state reads without relying on
    /// color alone.
    static func icon(for status: String) -> String {
        switch status {
        case "resolved": return "checkmark.seal.fill"
        case "rejected": return "xmark.seal.fill"
        default:         return "flag.fill"
        }
    }
}

/// Small capsule badge for a disputed grade row.
struct DisputeBadge: View {
    let status: String

    var body: some View {
        if let label = DisputeStatusDisplay.label(for: status) {
            let tone = DisputeStatusDisplay.tone(for: status)
            HStack(spacing: 3) {
                Image(systemName: DisputeStatusDisplay.icon(for: status))
                    .font(.caption2)
                    .accessibilityHidden(true)
                Text(label)
                    .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(tone)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(tone.opacity(0.12))
            .clipShape(Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(DisputeStatusDisplay.accessibilityLabel(for: status))
        }
    }
}
