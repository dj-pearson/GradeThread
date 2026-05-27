import SwiftUI

/// One field-suggestion row in the review screen. Renders the suggested
/// value, the upstream source (text vs which photo slot), a 0-100%
/// confidence bar, and a toggle for acceptance.
struct FieldSuggestionRow: View {
    let entry: FieldSuggestionEntry
    let isAccepted: Bool
    let onToggle: () -> Void

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
            .font(.system(size: 22))
            .foregroundStyle(isAccepted ? Color.brandNavy : .secondary)
            .padding(.top, 2)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(entry.displayLabel)
                    .font(.subheadline.weight(.semibold))
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
        }
    }

    private var confidenceBadge: some View {
        let pct = Int((entry.confidence * 100).rounded())
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
                    .frame(width: proxy.size.width * entry.confidence)
            }
        }
        .frame(height: 4)
    }

    private var confidenceColor: Color {
        switch entry.confidence {
        case 0.8...:  return Color.brandNavy
        case 0.5..<0.8: return .orange
        default:      return .red
        }
    }

    private var accessibilityLabel: String {
        let pct = Int((entry.confidence * 100).rounded())
        let state = isAccepted ? "accepted" : "not accepted"
        return "\(entry.displayLabel): \(entry.value). \(entry.sourceLabel). Confidence \(pct) percent. \(state)."
    }
}
