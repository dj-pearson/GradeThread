import SwiftUI

/// Single cell in the inventory list. Thumbnail · title · brand·size ·
/// price · status badge. Designed for one-handed iPhone use — entire
/// row is tappable, no inline actions.
struct InventoryRow: View {
    let item: LocalInventoryItem
    // US-1517: the shared cached formatter — one of these rows is constructed
    // per visible list cell, so a per-row init (2 NumberFormatters) was jank.
    private var currencyFormatter: CurrencyFormatter { .shared }
    /// US-686: drives the "AI processing… / Review ready" pill.
    @State private var aiManager = AIExtractionManager.shared
    @State private var reviewStore = AIFillReviewStore.shared

    var body: some View {
        HStack(spacing: 12) {
            thumbnail
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let priceLabel = priceLabel {
                    Text(priceLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                if let grade = item.gradeValue {
                    GradeChip(score: grade, label: item.gradeLabel)
                        .padding(.top, 1)
                }
                // US-683: at-a-glance "ready to list" cue. US-994: photo
                // presence now derives from the photos relationship.
                if isReadyToList {
                    Label("Ready to list", systemImage: "checkmark.seal.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.brandEmerald)
                        .padding(.top, 1)
                }
                aiStatusPill
            }

            Spacer(minLength: 8)

            StatusBadge(status: item.status)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    // MARK: - Subviews

    @ViewBuilder
    private var thumbnail: some View {
        // US-635: cached + downsampled (56pt cell never decodes full-res, and
        // scroll-back reuses the cached image instead of refetching).
        CachedThumbnail(
            url: item.primaryPhotoURL.flatMap { URL(string: $0) },
            maxDimension: 56
        ) {
            placeholderThumbnail
        }
    }

    /// US-686: AI-extraction status. "AI processing…" while a background
    /// extraction runs, then "Review ready" while a pending review is waiting to
    /// be opened (tapping the row pops it). Nothing once reviewed/cleared.
    @ViewBuilder
    private var aiStatusPill: some View {
        if aiManager.isRunning(item.id) {
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini).tint(Color.brandNavy)
                Text("AI processing…")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Color.brandNavy)
            .padding(.top, 1)
        } else if reviewStore.review(for: item.id)?.hasSomethingToReview == true {
            Label("Review ready", systemImage: "sparkles")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.brandNavy)
                .padding(.top, 1)
        } else if case .failed = aiManager.phase(for: item.id) {
            // Don't leave a silent "Untitled" item — show that AI didn't finish
            // (e.g. uploads timed out) so it's not mistaken for "still working".
            Label("AI didn't finish", systemImage: "exclamationmark.triangle.fill")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.brandAmber)
                .padding(.top, 1)
        }
    }

    private var placeholderThumbnail: some View {
        ZStack {
            RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous)
                .fill(Color.secondary.opacity(0.12))
            Image(systemName: "tshirt")
                .scaledIconFont(size: 22, weight: .light, maxSize: 40)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Derived strings

    private var subtitle: String {
        let parts = [item.brand, item.size].compactMap { $0?.nonEmpty }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    /// US-683/US-994: ready-to-list from local signals; photo presence comes
    /// from the photos relationship, not the denormalized primaryPhotoURL cache.
    private var isReadyToList: Bool {
        PublishReadiness.isReady(
            title: item.title,
            hasPhotos: item.hasPhotos,
            targetPrice: item.targetPrice,
            status: item.status
        )
    }

    private var priceLabel: String? {
        // Prefer the explicit list price, then target, then cost basis —
        // matches the web's price-display fallback.
        if let listing = item.listingPrice {
            return "\(currencyFormatter.formatDisplay(listing)) listed"
        }
        if let target = item.targetPrice {
            return "\(currencyFormatter.formatDisplay(target)) target"
        }
        if let cost = item.acquiredPrice {
            return "\(currencyFormatter.formatDisplay(cost)) cost"
        }
        return nil
    }

    private var accessibilityLabel: String {
        var parts: [String] = [item.title]
        if let brand = item.brand?.nonEmpty { parts.append("Brand \(brand)") }
        if let size = item.size?.nonEmpty { parts.append("Size \(size)") }
        if let priceLabel = priceLabel { parts.append(priceLabel) }
        if let grade = item.gradeValue {
            parts.append("Certified grade \(String(format: "%.1f", grade))")
        }
        parts.append("Status \(StatusBadge.label(for: item.status))")
        if aiManager.isRunning(item.id) {
            parts.append("AI processing")
        } else if reviewStore.review(for: item.id)?.hasSomethingToReview == true {
            parts.append("AI review ready")
        } else if case .failed = aiManager.phase(for: item.id) {
            parts.append("AI didn't finish")
        }
        return parts.joined(separator: ". ")
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
