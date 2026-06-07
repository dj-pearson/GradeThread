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
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

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
            }

            Spacer(minLength: 8)

            statusBadge
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
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.secondary.opacity(0.12))
            Image(systemName: "tshirt")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(.secondary)
        }
    }

    private var statusBadge: some View {
        Text(statusLabel)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(statusForeground)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(statusBackground)
            .clipShape(Capsule())
    }

    // MARK: - Derived strings

    private var subtitle: String {
        let parts = [item.brand, item.size].compactMap { $0?.nonEmpty }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
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

    private var statusLabel: String {
        item.status
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    // US-653: every pipeline stage gets a brand-token color rather than
    // collapsing most stages to gray. Sourced→comped (pre-list prep) read as
    // steel-navy work-in-progress; drafted as amber (ready, needs action);
    // listed as brand navy; sold/shipped/completed emerald; returned red.
    private var statusForeground: Color {
        switch item.status {
        case "sold", "shipped", "completed":              return .brandEmerald
        case "listed", "active":                          return .brandNavy
        case "drafted":                                   return .brandAmber
        case "returned":                                  return .brandRed
        case "sourced", "cataloged", "measured",
             "photographed", "comped":                    return .brandSteelNavy
        default:                                          return .secondary
        }
    }

    private var statusBackground: Color { statusForeground.opacity(0.12) }

    private var accessibilityLabel: String {
        var parts: [String] = [item.title]
        if let brand = item.brand?.nonEmpty { parts.append("Brand \(brand)") }
        if let size = item.size?.nonEmpty { parts.append("Size \(size)") }
        if let priceLabel = priceLabel { parts.append(priceLabel) }
        if let grade = item.gradeValue {
            parts.append("Certified grade \(String(format: "%.1f", grade))")
        }
        parts.append("Status \(statusLabel)")
        return parts.joined(separator: ". ")
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
