import SwiftUI

/// Renders a completed certified grade report: overall score, the five
/// weighted factor bars, the AI condition summary, and confidence — plus a
/// share button for the public certificate. Used both inside the request
/// sheet (on completion) and as a standalone report view from the canvas.
struct GradeReportView: View {
    let report: GradeReportDTO
    let certificateURL: URL?
    /// Optional item title for the header.
    var title: String?
    /// Optional submitted-photo thumbnails (full-report path only).
    var photoURLs: [URL] = []
    /// When provided, shows a "Dispute this grade" action (the full-report
    /// path provides it inside the dispute window).
    var onDispute: (() -> Void)? = nil

    private var defects: [GradeDefect] { report.defectsFound ?? [] }

    /// US-655: glow/border intensity respects Reduce Transparency.
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if !photoURLs.isEmpty { photoStrip }
                factorBreakdown
                if !defects.isEmpty { defectsCard }
                summaryCard
                confidenceCard
                if let certificateURL {
                    shareCertificate(certificateURL)
                }
                disclaimer
                if let onDispute {
                    disputeButton(onDispute)
                }
            }
            .padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 18) {
            GradeScoreRing(score: report.overallScore, tier: report.gradeTier)
            VStack(alignment: .leading, spacing: 6) {
                if let title, !title.isEmpty {
                    Text(title)
                        .font(.headline)
                        .lineLimit(2)
                }
                Text(report.gradeTier)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(GradeScale.color(for: report.overallScore))
                Text("Certified condition grade")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
        // US-655: tier-tinted border + glow on the report hero, strongest for a
        // pristine grade. Suppressed under Reduce Transparency.
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    GradeScale.color(for: report.overallScore)
                        .opacity(report.overallScore >= 9.5 ? 0.5 : 0.15),
                    lineWidth: 1
                )
        )
        .shadow(
            color: GradeScale.color(for: report.overallScore)
                .opacity(reduceTransparency ? 0 : (report.overallScore >= 9.5 ? 0.28 : 0.08)),
            radius: 14, y: 4
        )
    }

    private var photoStrip: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Submitted photos")
                .font(.subheadline.weight(.semibold))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(photoURLs, id: \.self) { url in
                        // US-635: cached + downsampled to the 92pt strip cell.
                        CachedThumbnail(url: url, maxDimension: 92) {
                            ZStack {
                                Color.secondary.opacity(0.1)
                                Image(systemName: "photo").foregroundStyle(.secondary)
                            }
                        }
                        .frame(width: 92, height: 92)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private var defectsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Detected issues")
                .font(.subheadline.weight(.semibold))
            ForEach(defects) { defect in
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(severityColor(defect.severity))
                        .frame(width: 8, height: 8)
                        .padding(.top, 5)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(defect.defect.capitalized)
                                .font(.footnote.weight(.medium))
                            Text(defect.severity.capitalized)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(severityColor(defect.severity))
                        }
                        if let location = defect.location, !location.isEmpty {
                            Text(location.capitalized)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private func severityColor(_ severity: String) -> Color {
        switch severity.lowercased() {
        case "major": return .brandRed
        case "moderate": return .orange
        default: return .secondary
        }
    }

    private var factorBreakdown: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Factor breakdown")
                .font(.subheadline.weight(.semibold))
            ForEach(GradeFactor.allCases) { factor in
                factorRow(factor)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private func factorRow(_ factor: GradeFactor) -> some View {
        let score = factor.score(in: report)
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(factor.label)
                    .font(.footnote)
                Text("\(Int(factor.weight * 100))%")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(String(format: "%.1f", score))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(GradeScale.color(for: score))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.15))
                    Capsule()
                        .fill(GradeScale.color(for: score))
                        .frame(width: max(4, geo.size.width * min(max(score / 10, 0), 1)))
                }
            }
            .frame(height: 7)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(factor.label), \(String(format: "%.1f", score)) of 10")
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("AI condition summary")
                .font(.subheadline.weight(.semibold))
            Text(report.aiSummary)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private var confidenceCard: some View {
        let conf = GradeScale.confidenceLabel(report.confidenceScore)
        return HStack(spacing: 12) {
            Image(systemName: report.confidenceScore >= 0.75 ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                .font(.title3)
                .foregroundStyle(conf.color)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(conf.label) confidence")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(conf.color)
                Text("\(Int((report.confidenceScore * 100).rounded()))% — \(report.confidenceScore < 0.75 ? "flagged for human review" : "high enough to certify automatically")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private func shareCertificate(_ url: URL) -> some View {
        VStack(spacing: 10) {
            ShareLink(item: url) {
                Label("Share certificate", systemImage: "square.and.arrow.up")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            Text("Buyers can verify this grade on a public certificate page — fewer “not as described” disputes.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private func disputeButton(_ action: @escaping () -> Void) -> some View {
        Button {
            AppRouter.haptic()
            action()
        } label: {
            Label("Dispute this grade", systemImage: "flag")
                .font(.subheadline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(.bordered)
        .tint(.secondary)
    }

    private var disclaimer: some View {
        Text("AI-generated condition estimate — not a professional appraisal or guarantee. Lower-confidence grades are routed to a human reviewer.")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}
