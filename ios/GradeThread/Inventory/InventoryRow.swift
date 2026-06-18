import SwiftUI

/// Single cell in the inventory list. Thumbnail · title · brand·size ·
/// price · status badge. Designed for one-handed iPhone use — entire
/// row is tappable, no inline actions.
struct InventoryRow: View {
    let item: LocalInventoryItem
    private let currencyFormatter = CurrencyFormatter()

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
                // US-683: at-a-glance "ready to list" cue (primaryPhotoURL is
                // the row's stand-in for "has photos").
                if isReadyToList {
                    Label("Ready to list", systemImage: "checkmark.seal.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.brandEmerald)
                        .padding(.top, 1)
                }
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

    /// US-683: ready-to-list from local signals (primaryPhotoURL stands in for
    /// "has photos" since the row doesn't query the full photo list).
    private var isReadyToList: Bool {
        PublishReadiness.isReady(
            title: item.title,
            hasPhotos: item.primaryPhotoURL?.nonEmpty != nil,
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
        return parts.joined(separator: ". ")
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
