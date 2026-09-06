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
    /// US-1052: resolves `sources.id` → display name so source chips read
    /// "Goodwill" rather than a raw UUID. Missing ids fall back to the id.
    var sourceNames: [String: String] = [:]

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
        for category in criteria.categories.sorted() {
            out.append(Chip(id: "category-\(category)", label: InventoryFacets.categoryLabel(category)) {
                criteria.categories.remove(category)
            })
        }
        for source in criteria.sources.sorted() {
            out.append(Chip(id: "source-\(source)", label: sourceNames[source] ?? source) {
                criteria.sources.remove(source)
            })
        }
        // US-3124: the chip carries the person's name, which needs no lookup —
        // sourced_by IS the name (unlike a source, which is an id).
        for who in criteria.sourcers.sorted() {
            out.append(Chip(id: "sourcer-\(who)", label: "Sourced by \(who)") {
                criteria.sourcers.remove(who)
            })
        }

        if let floor = criteria.minGrade {
            out.append(Chip(id: "grade", label: "Grade ≥ \(String(format: "%.1f", floor))") {
                // US-1185: clearing the min-grade chip keeps `gradedOnly` so the
                // now-visible "Graded" chip lets the user drop that filter
                // independently (was clearing both with one tap).
                criteria.minGrade = nil
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

        if criteria.purchaseDates.isActive {
            out.append(Chip(id: "purchased", label: dateBandLabel("Bought", criteria.purchaseDates)) {
                criteria.purchaseDates = .init()
            })
        }
        if criteria.saleDates.isActive {
            out.append(Chip(id: "sold", label: dateBandLabel("Sold", criteria.saleDates)) {
                criteria.saleDates = .init()
            })
        }

        if criteria.ruleQuery.isActive {
            let n = criteria.ruleQuery.effectiveRules.count
            let combo = criteria.ruleQuery.combinator.label.lowercased()
            out.append(Chip(id: "rules", label: "\(n) rule\(n == 1 ? "" : "s") · \(combo)") {
                criteria.ruleQuery = .empty
            })
        }

        return out
    }

    /// Compact "Bought after Jun 1" / "Sold Jun 1–Jun 18" chip label.
    private func dateBandLabel(_ verb: String, _ band: InventoryFilterCriteria.DateBand) -> String {
        let from = band.from.map { $0.formatted(.dateTime.month(.abbreviated).day()) }
        let to = band.to.map { $0.formatted(.dateTime.month(.abbreviated).day()) }
        switch (from, to) {
        case let (f?, t?): return "\(verb) \(f)–\(t)"
        case let (f?, nil): return "\(verb) after \(f)"
        case let (nil, t?): return "\(verb) before \(t)"
        default:            return verb
        }
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
        // US-706: the visual chip is ~28pt tall; expand the tap target to 44pt.
        .frame(minHeight: 44)
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
