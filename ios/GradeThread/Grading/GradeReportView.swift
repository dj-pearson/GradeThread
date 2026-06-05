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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                factorBreakdown
                summaryCard
                confidenceCard
                if let certificateURL {
                    shareCertificate(certificateURL)
                }
                disclaimer
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
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

    private var disclaimer: some View {
        Text("AI-generated condition estimate — not a professional appraisal or guarantee. Lower-confidence grades are routed to a human reviewer.")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}
