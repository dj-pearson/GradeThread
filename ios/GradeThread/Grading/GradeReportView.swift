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

    /// US-1209/US-1409: true when this grade is awaiting human review, so it
    /// isn't shareable as a certificate yet.
    ///
    /// US-1409 fix: a certificate is only ever attached to a FINALIZED grade —
    /// a reviewer approved a low-confidence one, or it auto-approved. So a
    /// present `certificateURL` is the authoritative "certified" signal; we must
    /// not re-derive "pending" from raw confidence and then suppress Share for a
    /// grade that already HAS a certificate (a human-approved sub-0.75 grade).
    /// Only treat as pending when there is no certificate AND confidence is below
    /// the certify floor.
    private var pendingReview: Bool {
        certificateURL == nil
            && GradeScale.requiresReview(confidence: report.confidenceScore)
    }

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
                // US-1209: a low-confidence grade is provisional (routed to a
                // human reviewer), so it must not be presented as a certified,
                // shareable result. Suppress the Share Certificate CTA and show
                // a pending-review notice in its place until review clears.
                if pendingReview {
                    pendingReviewNotice
                } else if let certificateURL {
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
                        // US-654: certificate/report title uses the Outfit display face.
                        .font(.brandHeadline)
                        .lineLimit(2)
                }
                Text(report.gradeTier)
                    .font(.brandSubhead)
                    .foregroundStyle(GradeScale.color(for: report.overallScore))
                // US-1209: don't label a provisional (sub-threshold) grade as
                // "Certified" — it's still awaiting human review.
                Text(pendingReview ? "Provisional grade · pending review" : "Certified condition grade")
                    .font(.caption)
                    .foregroundStyle(pendingReview ? Color.brandAmber : .secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
        // US-655: tier-tinted border + glow on the report hero, strongest for a
        // pristine grade. Suppressed under Reduce Transparency.
        .overlay(
            RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous)
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
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
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
                    // Non-color severity signal (US-1012): each severity gets a
                    // distinct SF Symbol shape so it reads without relying on
                    // color, for low-vision / color-blind users.
                    Image(systemName: severityIcon(defect.severity))
                        .font(.footnote)
                        .foregroundStyle(severityColor(defect.severity))
                        .accessibilityHidden(true)
                        .padding(.top, 1)
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
        case "moderate": return .brandAmber
        default: return .secondary
        }
    }

    /// Distinct glyph per severity so the level is conveyed by shape, not just
    /// color (US-1012 accessibility — color-only signals fail WCAG 1.4.1).
    private func severityIcon(_ severity: String) -> String {
        switch severity.lowercased() {
        case "major": return "exclamationmark.octagon.fill"
        case "moderate": return "exclamationmark.triangle.fill"
        default: return "info.circle.fill"
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
            Image(systemName: GradeScale.requiresReview(confidence: report.confidenceScore)
                ? "exclamationmark.shield.fill" : "checkmark.shield.fill")
                .font(.title3)
                .foregroundStyle(conf.color)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(conf.label) confidence")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(conf.color)
                // US-2309: this used to read "high enough to certify
                // automatically" for anything at or above the review threshold.
                // It is not: the review threshold (0.75) decides whether a grade
                // is FLAGGED, and a separate server-side floor decides whether it
                // finalizes without a human — a grade at 0.80 is neither flagged
                // nor auto-approved, and this card promised it would certify
                // itself. The client also has no business knowing the second
                // number: it is env-tunable server-side, and re-deriving server
                // state from raw confidence is the same defect US-1409 recorded
                // three times in this file. So the copy now says only what the
                // threshold it does own actually means.
                Text("\(Int((report.confidenceScore * 100).rounded()))% — \(GradeScale.requiresReview(confidence: report.confidenceScore) ? "flagged for human review" : "above the review threshold")")
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
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }
            Text("Buyers can verify this grade on a public certificate page — fewer “not as described” disputes.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    /// US-1209: shown in place of the Share Certificate CTA for a provisional
    /// (low-confidence) grade. The grade can't be shared as a certificate until
    /// a human reviewer clears it, so we explain that rather than offering a
    /// dead/disabled share button.
    private var pendingReviewNotice: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.fill.checkmark")
                .font(.title3)
                .foregroundStyle(.brandAmber)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("Pending human review")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.brandAmber)
                Text("This grade's confidence is below our certify threshold, so a reviewer is taking a look. You'll be able to share a public certificate once it clears.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.brandAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
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
        Text("A condition estimate from AI. It is not an appraisal and not a guarantee. When the AI is unsure, a person checks the grade.")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.brandAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }
}
