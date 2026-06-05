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
        if let urlString = item.primaryPhotoURL, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .empty:
                    placeholderThumbnail
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .failure:
                    placeholderThumbnail
                @unknown default:
                    placeholderThumbnail
                }
            }
        } else {
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

    private var statusForeground: Color {
        switch item.status {
        case "sold", "shipped", "completed":  return .green
        case "listed":                         return Color.brandNavy
        case "returned":                       return .red
        default:                               return .secondary
        }
    }

    private var statusBackground: Color {
        switch item.status {
        case "sold", "shipped", "completed":  return .green.opacity(0.12)
        case "listed":                         return Color.brandNavy.opacity(0.12)
        case "returned":                       return .red.opacity(0.12)
        default:                               return .secondary.opacity(0.12)
        }
    }

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
