import SwiftUI

/// One ScoutAI candidate: photo · title · shadow grade + confidence · the
/// asking / est-value / est-margin triad · reason · a link out to the live
/// eBay listing. Mirrors the web `CandidateRow`.
struct ScoutCandidateRow: View {
    let candidate: ScoutCandidate

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                thumbnail
                    .frame(width: 76, height: 76)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .top, spacing: 6) {
                        Text(candidate.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        if candidate.underpriced {
                            Label("Deal", systemImage: "arrow.up.right")
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Color.green.opacity(0.15))
                                .foregroundStyle(.green)
                                .clipShape(Capsule())
                        }
                    }
                    gradeLine
                }
            }

            metricsRow

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(candidate.reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if let urlString = candidate.itemWebUrl, let url = URL(string: urlString) {
                    Link(destination: url) {
                        HStack(spacing: 3) {
                            Text("eBay")
                            Image(systemName: "arrow.up.right.square")
                        }
                        .font(.caption.weight(.semibold))
                    }
                }
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(candidate.underpriced ? Color.green.opacity(0.5) : .clear, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    // MARK: - Subviews

    @ViewBuilder
    private var thumbnail: some View {
        // US-635: cached + downsampled to the 76pt cell.
        CachedThumbnail(
            url: candidate.imageUrl.flatMap { URL(string: $0) },
            maxDimension: 76
        ) {
            placeholder
        }
    }

    private var placeholder: some View {
        ZStack {
            Rectangle().fill(Color.secondary.opacity(0.12))
            Image(systemName: "tshirt")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(.secondary)
        }
    }

    private var gradeLine: some View {
        HStack(spacing: 6) {
            Text("Shadow \(Self.gradeText(candidate.shadowGrade))")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Self.gradeColor(candidate.shadowGrade).opacity(0.15))
                .foregroundStyle(Self.gradeColor(candidate.shadowGrade))
                .clipShape(Capsule())
            Text("\(Int((candidate.gradeConfidence * 100).rounded()))% confidence")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if !candidate.actionable {
                Text("Uncertain")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .overlay(Capsule().strokeBorder(.secondary.opacity(0.4)))
            }
        }
    }

    private var metricsRow: some View {
        HStack(spacing: 0) {
            metric("Asking", Self.dollars(candidate.askingCents), tint: .primary)
            Divider().frame(height: 28)
            metric("Est. value", valueText, tint: .primary)
            Divider().frame(height: 28)
            metric("Est. margin", marginText, tint: marginTint)
        }
    }

    private func metric(_ label: String, _ value: String, tint: Color) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Derived strings

    private var valueText: String {
        guard candidate.valueMedianCents != nil else { return "—" }
        return "\(Self.dollars(candidate.valueLowCents))–\(Self.dollars(candidate.valueHighCents))"
    }

    private var marginText: String {
        guard let margin = candidate.estMarginCents else { return "—" }
        let pct = candidate.estMarginPct.map { " (\(Int(($0 * 100).rounded()))%)" } ?? ""
        return Self.dollars(margin) + pct
    }

    private var marginTint: Color {
        guard let margin = candidate.estMarginCents else { return .secondary }
        return margin > 0 ? .green : .secondary
    }

    // MARK: - Formatting

    static func dollars(_ cents: Int?) -> String {
        guard let cents else { return "—" }
        let dollars = Double(cents) / 100
        return "$" + String(format: "%.2f", dollars)
    }

    static func gradeText(_ grade: Double?) -> String {
        guard let grade else { return "—" }
        return String(format: "%.1f", grade)
    }

    static func gradeColor(_ grade: Double?) -> Color {
        guard let grade else { return .secondary }
        if grade >= 8 { return .green }
        if grade >= 6 { return .orange }
        return .red
    }
}
