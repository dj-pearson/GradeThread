import SwiftUI

/// One ScoutAI candidate: photo · title · shadow grade + confidence · the
/// asking / est-value / est-margin triad · reason · a link out to the live
/// eBay listing. Mirrors the web `CandidateRow`.
struct ScoutCandidateRow: View {
    let candidate: ScoutCandidate
    /// US-3097: the row's two actions live with the store, not the row, so a
    /// buy survives the row scrolling out of the LazyVStack.
    var isBuying: Bool = false
    var isBought: Bool = false
    var onBuy: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // US-703: the informational content collapses into ONE VoiceOver
            // element with a curated label (instead of `.combine`, which
            // fragmented the text AND swallowed the eBay link below).
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    thumbnail
                        .frame(width: 76, height: 76)
                        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))

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
                                    .background(Color.brandEmerald.opacity(0.15))
                                    .foregroundStyle(Color.brandEmerald)
                                    .clipShape(Capsule())
                            }
                        }
                        gradeLine
                    }
                }

                metricsRow

                Text(candidate.reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                // US-3097 / US-2850: what the est. value is made of. Without it
                // a measured number and an unadjusted comp median render
                // identically, and the seller has no way to tell which one they
                // are about to spend money on.
                if let basis = candidate.valueBasis {
                    Text(basis.headline)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilitySummary)

            // The actions stay separate, reachable accessibility elements.
            HStack(spacing: 12) {
                if onBuy != nil {
                    boughtItButton
                }
                Spacer(minLength: 0)
                // US-3097: UIApplication.open, not a SwiftUI Link. Only the
                // former hands an ebay.com universal link to the installed eBay
                // app — where the seller is already signed in and can buy the
                // item they are standing in front of. `outboundURL` prefers the
                // affiliate URL the server will send once US-3082 lands.
                if let url = candidate.outboundURL {
                    EbayOutboundLink(url: url, surface: "scout_candidate") {
                        HStack(spacing: 3) {
                            Text("eBay")
                            Image(systemName: "arrow.up.right.square")
                        }
                        .font(.caption.weight(.semibold))
                    }
                    .accessibilityLabel("View on eBay")
                }
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .overlay(
            RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous)
                .strokeBorder(candidate.underpriced ? Color.brandEmerald.opacity(0.5) : .clear, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
    }

    /// US-703: composed VoiceOver label — title, deal flag, shadow grade +
    /// confidence, the asking/value/margin triad, and the reason, so the deal
    /// signal is spoken rather than implied by the border colour. Internal so
    /// the composition is unit-tested.
    var accessibilitySummary: String {
        var parts: [String] = [candidate.title]
        if candidate.underpriced { parts.append("Deal") }
        if let grade = candidate.shadowGrade {
            parts.append("shadow grade \(Self.gradeText(grade)) out of 10")
        }
        parts.append("\(Int((candidate.gradeConfidence * 100).rounded())) percent confidence")
        if !candidate.actionable { parts.append("uncertain") }
        parts.append("asking \(Self.dollars(candidate.askingCents))")
        if candidate.valueMedianCents != nil { parts.append("estimated value \(valueText)") }
        if candidate.estMarginCents != nil { parts.append("estimated margin \(marginText)") }
        parts.append(candidate.reason)
        return parts.joined(separator: ", ")
    }

    // MARK: - Subviews

    /// "Bought it" → an inventory row at `sourced`, priced at the asking price.
    ///
    /// Disabled and relabelled once it has run. A second tap would write a
    /// second item for one garment, and the seller would find the duplicate
    /// days later with no way to tell which one is real.
    @ViewBuilder private var boughtItButton: some View {
        if isBought {
            Label("Added", systemImage: "checkmark.circle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.brandEmerald)
                .accessibilityLabel("Added to inventory")
        } else {
            Button {
                onBuy?()
            } label: {
                if isBuying {
                    ProgressView().controlSize(.mini)
                } else {
                    Label("Bought it", systemImage: "bag.badge.plus")
                        .font(.caption.weight(.semibold))
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(isBuying)
            .accessibilityLabel("Bought it, add to inventory")
        }
    }

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
                .scaledIconFont(size: 22, weight: .light, maxSize: 40)
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
        return margin > 0 ? Color.brandEmerald : .secondary
    }

    // MARK: - Formatting

    static func dollars(_ cents: Int?) -> String {
        guard let cents else { return "—" }
        // US-1196: route through CurrencyFormatter so a loss renders "-$5.00",
        // not the malformed "$-5.00" from prepending "$" to a negative number.
        return CurrencyFormatter.shared.formatDisplay(Double(cents) / 100)
    }

    static func gradeText(_ grade: Double?) -> String {
        guard let grade else { return "—" }
        return String(format: "%.1f", grade)
    }

    // US-653: defer to the canonical brand GradeScale mapping instead of a
    // local green/orange/red map.
    static func gradeColor(_ grade: Double?) -> Color {
        guard let grade else { return .secondary }
        return GradeScale.color(for: grade)
    }
}
