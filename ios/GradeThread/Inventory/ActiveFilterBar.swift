import SwiftUI

/// Horizontally-scrolling row of removable chips summarizing the active
/// ``InventoryFilterCriteria``, shown directly under the search bar so the
/// user always sees *why* the list is narrowed and can peel off any one
/// facet with a single tap. A trailing "Clear all" resets everything.
///
/// Renders nothing when no facet is active.
struct ActiveFilterBar: View {
    @Binding var criteria: InventoryFilterCriteria
    var currencyFormatter = CurrencyFormatter()

    var body: some View {
        if criteria.isActive {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(chips) { chip in
                        FilterChip(label: chip.label) {
                            withAnimation(.snappy) { chip.remove() }
                        }
                    }

                    Button {
                        AppRouter.haptic()
                        withAnimation(.snappy) { criteria = .empty }
                    } label: {
                        Text("Clear all")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.brandRed)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .background(Color(uiColor: .systemBackground))
        }
    }

    // MARK: - Chip model

    private struct Chip: Identifiable {
        let id: String
        let label: String
        let remove: () -> Void
    }

    /// Flattens the active criteria into one chip per removable unit. Each
    /// selected brand/size/color gets its own chip so they can be peeled
    /// off individually; band/toggle facets get a single summary chip.
    private var chips: [Chip] {
        var out: [Chip] = []

        for brand in criteria.brands.sorted() {
            out.append(Chip(id: "brand-\(brand)", label: brand) {
                criteria.brands.remove(brand)
            })
        }
        for size in criteria.sizes.sorted() {
            out.append(Chip(id: "size-\(size)", label: "Size \(size)") {
                criteria.sizes.remove(size)
            })
        }
        for color in criteria.colors.sorted() {
            out.append(Chip(id: "color-\(color)", label: color) {
                criteria.colors.remove(color)
            })
        }

        if let floor = criteria.minGrade {
            out.append(Chip(id: "grade", label: "Grade ≥ \(String(format: "%.1f", floor))") {
                criteria.minGrade = nil
                criteria.gradedOnly = false
            })
        } else if criteria.gradedOnly {
            out.append(Chip(id: "graded", label: "Graded") {
                criteria.gradedOnly = false
            })
        }

        if criteria.minPrice != nil || criteria.maxPrice != nil {
            out.append(Chip(id: "price", label: priceLabel) {
                criteria.minPrice = nil
                criteria.maxPrice = nil
            })
        }

        if criteria.photoState != .any {
            out.append(Chip(id: "photo", label: criteria.photoState.label) {
                criteria.photoState = .any
            })
        }

        if criteria.dateAdded != .any {
            out.append(Chip(id: "date", label: criteria.dateAdded.label) {
                criteria.dateAdded = .any
            })
        }

        return out
    }

    private var priceLabel: String {
        let lo = criteria.minPrice.map { currencyFormatter.formatDisplay($0) }
        let hi = criteria.maxPrice.map { currencyFormatter.formatDisplay($0) }
        switch (lo, hi) {
        case let (lo?, hi?): return "\(lo)–\(hi)"
        case let (lo?, nil): return "≥ \(lo)"
        case let (nil, hi?): return "≤ \(hi)"
        default:             return "Price"
        }
    }
}

/// A single removable filter chip: label + an "x" tap target.
private struct FilterChip: View {
    let label: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.caption.weight(.medium))
                .lineLimit(1)
            Image(systemName: "xmark")
                .font(.caption2.weight(.bold))
        }
        .foregroundStyle(Color.brandNavy)
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .background(Color.brandNavy.opacity(0.12))
        .clipShape(Capsule())
        .contentShape(Capsule())
        .onTapGesture {
            AppRouter.haptic()
            onRemove()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Remove filter \(label)")
        .accessibilityAddTraits(.isButton)
    }
}
