import SwiftUI

/// One field-suggestion row in the review screen. Renders the suggested
/// value, the upstream source (text vs which photo slot), a 0-100%
/// confidence bar, and a toggle for acceptance.
struct FieldSuggestionRow: View {
    let entry: FieldSuggestionEntry
    let isAccepted: Bool
    let onToggle: () -> Void
    /// US-1527: the identification rationale, shown under a research-tier row
    /// ("Identified" badge) so the user can verify the AI's product ID before
    /// accepting. nil for observed rows and callers that predate research.
    var researchRationale: String? = nil

    var body: some View {
        Button(action: onToggle) {
            HStack(alignment: .top, spacing: 12) {
                checkbox
                content
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isAccepted ? .isSelected : [])
    }

    // MARK: - Subviews

    private var checkbox: some View {
        Image(systemName: isAccepted ? "checkmark.circle.fill" : "circle")
            .scaledIconFont(size: 22)
            .foregroundStyle(isAccepted ? Color.brandNavy : .secondary)
            .padding(.top, 2)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(entry.displayLabel)
                    .font(.subheadline.weight(.semibold))
                if entry.source == "research" {
                    identifiedBadge
                }
                Spacer(minLength: 8)
                confidenceBadge
            }
            Text(entry.value)
                .font(.body)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .textSelection(.enabled)

            HStack(spacing: 8) {
                Text(entry.sourceLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                confidenceBar
                    .frame(width: 90)
            }

            // US-1527: the identification's photo-evidence rationale — the
            // user verifies the named product before accepting it.
            if entry.source == "research", let rationale = researchRationale,
               !rationale.isEmpty {
                Text("Why: \(rationale)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// US-1527: research-tier rows are the AI NAMING the product from its own
    /// knowledge — visually distinct from observed (read-off-the-tag) fields.
    private var identifiedBadge: some View {
        Text("Identified")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.purple)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.purple.opacity(0.12))
            .clipShape(Capsule())
    }

    /// Defensive clamp to the documented 0…1 contract. A backend that emits an
    /// out-of-range confidence (negative in particular) would otherwise drive a
    /// NEGATIVE SwiftUI frame width below, which traps at layout time.
    private var clampedConfidence: Double { min(max(entry.confidence, 0), 1) }

    private var confidenceBadge: some View {
        let pct = Int((clampedConfidence * 100).rounded())
        return Text("\(pct)%")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(confidenceColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(confidenceColor.opacity(0.12))
            .clipShape(Capsule())
    }

    private var confidenceBar: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(.secondary.opacity(0.15))
                Capsule()
                    .fill(confidenceColor)
                    .frame(width: proxy.size.width * clampedConfidence)
            }
        }
        .frame(height: 4)
    }

    // US-653: reuse the canonical GradeScale.confidenceLabel brand mapping
    // (High→emerald, Medium→amber, Low→red) so AI-extract confidence reads in
    // the same brand language as grade confidence everywhere else.
    private var confidenceColor: Color {
        GradeScale.confidenceLabel(entry.confidence).color
    }

    private var accessibilityLabel: String {
        let pct = Int((entry.confidence * 100).rounded())
        let state = isAccepted ? "accepted" : "not accepted"
        return "\(entry.displayLabel): \(entry.value). \(entry.sourceLabel). Confidence \(pct) percent. \(state)."
    }
}
