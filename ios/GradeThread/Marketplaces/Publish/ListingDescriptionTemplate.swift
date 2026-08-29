import Foundation

/// US-2818 - the Swift mirror of `src/lib/listing-templates.ts`.
///
/// The buyer-facing description iOS wrote came from one place: the AI's
/// free-form `/listing-copy` answer in the publish dialog. The web composer has
/// had a structured, per-garment template since US-827 - an opening line, the
/// attributes and an honest condition statement - and that structure is most of
/// why the web copy reads better. None of it needs a network call or a model.
///
/// US-2964 TOOK THE RENDERING OUT. The measurement table, the grade line and the
/// "Verified Seller" block used to be interpolated here, and each of them is now
/// its OWN description block rendered by the edge service on every save. Two
/// copies of a fact is how a seller ends up fixing a measurement and still
/// publishing the old number, so the local half was deleted rather than kept in
/// sync: `measurementsBlock`, `gradeBlock`, `ensureGradeLine`,
/// `splitSellerCredentials` and `ensureSellerCredentials` are gone, and the
/// template a caller builds is folded into the `intro` block by
/// `DescriptionBlocks.applyWholeText`.
///
/// What is left is the prose skeleton, plus the measurement VALUE formatter -
/// the in/cm/US/mm rules, which are unit conversion rather than description
/// rendering and are the tested mirror of the web's.
///
/// Keep the templates in lockstep with the web copies; they are pure data.
enum ListingDescriptionTemplate {

    // MARK: - Facts

    /// Everything a template interpolates, read off the local item. Value-typed
    /// so the whole build is pure and unit-testable.
    struct Facts: Equatable {
        var brand: String
        var title: String
        var size: String
        var color: String
        var material: String
        /// `inventory_items.condition_notes` - the seller's own honest note.
        var conditionNotes: String
        /// e.g. "Excellent" off the grade report, used when there is no note.
        var gradeLabel: String
        /// `inventory_items.grade_value`, 1.0-10.0. nil when ungraded.
        ///
        /// Still here because the condition line falls back through it, and
        /// because a caller building facts should not have to know which of them
        /// the template happens to print today. The GRADE LINE itself is the
        /// `grade` block's job now.
        var gradeValue: Double?
        /// Canonical measurement keys, holding the stored FLAT values.
        var measurements: [String: Double]
        /// The garment word that picks the template. See `GarmentGroup.from`.
        var garmentDescriptor: String

        init(
            brand: String = "",
            title: String = "",
            size: String = "",
            color: String = "",
            material: String = "",
            conditionNotes: String = "",
            gradeLabel: String = "",
            gradeValue: Double? = nil,
            measurements: [String: Double] = [:],
            garmentDescriptor: String = ""
        ) {
            self.brand = brand
            self.title = title
            self.size = size
            self.color = color
            self.material = material
            self.conditionNotes = conditionNotes
            self.gradeLabel = gradeLabel
            self.gradeValue = gradeValue
            self.measurements = measurements
            self.garmentDescriptor = garmentDescriptor
        }
    }

    // MARK: - Templates

    /// Per-group description templates, mirroring the web `DESCRIPTION_TEMPLATES`
    /// and keyed by ``GarmentGroup`` instead of the web `MeasurementGroup` (the
    /// same taxonomy under a different name).
    ///
    /// No `{{measurements}}` and no `{{grade}}`: both are their own blocks, and a
    /// template that restated them would print each fact twice.
    static func template(for group: GarmentGroup) -> String {
        switch group {
        case .top, .bottom, .dress, .outerwear:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Smoke-free home. Ships fast. Questions welcome.
            """
        case .suit:
            // The one template that says "two pieces" out loud. A suit buyer's
            // first question is whether the jacket and trousers are the same
            // suit, so the sold-as-a-set line is body copy, not a nicety.
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Sold as a two-piece set — jacket and trousers together.

            Smoke-free home. Ships fast. Questions welcome.
            """
        case .shoes:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}

            Condition: {{condition}}

            Smoke-free home. Ships fast. Questions welcome.
            """
        case .watch:
            return """
            {{brand}} {{title}}

            Condition: {{condition}}

            Ships insured. Questions welcome.
            """
        case .headwear:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Smoke-free home. Ships fast. Questions welcome.
            """
        case .accessory:
            return """
            {{brand}} {{title}}

            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Smoke-free home. Ships fast. Questions welcome.
            """
        case .bag:
            return """
            {{brand}} {{title}}

            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Comes from a smoke-free home. Ships boxed. Questions welcome.
            """
        case .generic:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Smoke-free home. Ships fast. Questions welcome.
            """
        }
    }

    // MARK: - Measurement values

    /// Keys stored FOLDED FLAT, so the worn number a buyer shops by is twice the
    /// stored one. Mirrors the web `CIRCUMFERENCE_KEYS`.
    static let circumferenceKeys: Set<String> = [
        "chest", "bust", "waist", "hip", "leg_opening",
    ]

    private static let inchesToCentimeters = 2.54

    /// Trim a trailing ".0", the way the web `trimNum` does.
    private static func trimNum(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded == rounded.rounded() { return String(Int(rounded)) }
        return String(format: "%g", rounded)
    }

    /// One formatted value, honoring the seller's in/cm preference. Shoe sizes
    /// are US numeric and watch dimensions are millimetres, so neither converts.
    ///
    /// This is the piece US-2964 deliberately kept: it is unit conversion, not
    /// description rendering, and it is the tested mirror of the web's rules.
    static func formatValue(
        key: String,
        value: Double,
        unit: MeasurementUnit
    ) -> String {
        switch MeasurementCatalog.kind(for: key) {
        case .shoe:
            return "US " + trimNum(value)
        case .mm:
            return trimNum(value) + " mm"
        case .length:
            if unit == .centimeters {
                return trimNum(value * inchesToCentimeters) + " cm"
            }
            return trimNum(value) + " in"
        }
    }

    /// The measurement lines, canonical keys first. Mirrors the web
    /// `buildMeasurementLines`: a folded-flat measurement shows the worn number
    /// a buyer shops by AND the flat number they can reproduce with their own
    /// tape, because publishing only one of the two makes a listing argue with
    /// itself.
    ///
    /// The edge renderer owns the measurement BLOCK; this is the same line rule
    /// expressed once in Swift so the formatting contract stays covered by a
    /// test that runs without a server.
    static func measurementLines(
        _ measurements: [String: Double],
        unit: MeasurementUnit
    ) -> [String] {
        MeasurementCatalog.ordered(measurements.keys).compactMap { key -> String? in
            guard let value = measurements[key], value > 0 else { return nil }
            let flat = formatValue(key: key, value: value, unit: unit)
            let label = MeasurementCatalog.label(for: key)
            guard circumferenceKeys.contains(key) else { return label + ": " + flat }
            let worn = formatValue(key: key, value: value * 2, unit: unit)
            return label + ": " + worn + " (" + flat + " flat)"
        }
    }

    // MARK: - Build

    /// The group whose template this item gets.
    static func group(for facts: Facts) -> GarmentGroup {
        GarmentGroup.from(facts.garmentDescriptor)
    }

    /// The six coarse `garment_type` values, which name a VERTICAL rather than a
    /// garment. The column is derived from `item_category` whenever intake never
    /// captured one, so on an unclassified item it reads "tops" whether the
    /// garment is a t-shirt or a pair of jeans. They still resolve - "bottoms"
    /// with nothing else on the row beats `generic` - they just go last.
    private static let coarseVerticals: Set<String> = [
        "tops", "bottoms", "outerwear", "dresses", "footwear", "accessories",
    ]

    /// The last segment of an eBay category path, or nil.
    ///
    /// Mirrors the web `ebayCategoryLeaf`. Both separators are handled because
    /// eBay's own payloads use the ASCII `>` and its Browse responses use `›`,
    /// and a path split on only one of them yields the whole path as a single
    /// "leaf" - which then never resolves to a group and silently contributes
    /// nothing.
    static func ebayCategoryLeaf(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let segments = path
            .split(whereSeparator: { $0 == ">" || $0 == "\u{203A}" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return segments.last
    }

    /// One candidate for the descriptor, and whether the coarse filter may
    /// demote it.
    private struct Candidate {
        let value: String
        /// False means "never demoted for being a coarse vertical".
        let coarseEligible: Bool
    }

    /// Pick the string that should decide the template, most-specific-first.
    ///
    /// Mirrors the web `garmentDescriptorFor` candidate for candidate. A
    /// candidate only wins if it resolves to a real group, so `item_category`'s
    /// literal "clothing" is skipped rather than swallowing the answer, and the
    /// title is a genuine last resort ("Vintage Levi's 550 Denim Shorts" beats
    /// nothing).
    ///
    /// US-2955: THE EBAY LEAF GOES FIRST AND IS NEVER DEMOTED. Until this, iOS
    /// never consulted the leaf at all - so a seller who corrected an item's
    /// eBay category to a Tops leaf still got the template `garmentCategory`
    /// implied, and a top went on asking for an inseam. It is exempt from the
    /// coarse filter for the same reason the web exempts it: the leaf is a
    /// value eBay assigned to THIS item, so even when it reads "Tops" that is a
    /// statement about the garment rather than a vertical we derived when
    /// intake told us nothing.
    static func garmentDescriptor(
        ebayLeaf: String? = nil,
        garmentCategory: String?,
        garmentType: String?,
        itemCategory: String?,
        style: String?,
        title: String?
    ) -> String {
        let candidates: [Candidate] = [
            Candidate(value: ebayLeaf ?? "", coarseEligible: false),
            Candidate(value: garmentCategory ?? "", coarseEligible: true),
            Candidate(value: garmentType ?? "", coarseEligible: true),
            Candidate(value: itemCategory ?? "", coarseEligible: true),
            Candidate(value: style ?? "", coarseEligible: true),
            // A title is free text a human wrote, not a derived vertical, and it
            // is the last resort anyway.
            Candidate(value: title ?? "", coarseEligible: false),
        ]
            .map {
                Candidate(
                    value: $0.value.trimmingCharacters(in: .whitespacesAndNewlines),
                    coarseEligible: $0.coarseEligible
                )
            }
            .filter { !$0.value.isEmpty }

        // Two passes over the same list, so the order above still expresses
        // preference within each tier: everything specific first, verticals
        // after.
        for candidate in candidates {
            if candidate.coarseEligible && coarseVerticals.contains(candidate.value.lowercased()) {
                continue
            }
            if GarmentGroup.from(candidate.value) != .generic { return candidate.value }
        }
        for candidate in candidates where GarmentGroup.from(candidate.value) != .generic {
            return candidate.value
        }
        return candidates.first?.value ?? ""
    }

    /// Fill one template. Mirrors the web `interpolateDescription`, with one
    /// deliberate improvement: the web fills `color` and `material` with an
    /// em-dash placeholder because `items_full` exposes neither column, and iOS
    /// reads the item row directly - so it fills the real values and falls back
    /// to the placeholder only when the field is genuinely blank.
    static func interpolate(template: String, facts: Facts) -> String {
        let condition: String = {
            let notes = facts.conditionNotes.trimmingCharacters(in: .whitespacesAndNewlines)
            if !notes.isEmpty { return notes }
            let label = facts.gradeLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            if !label.isEmpty { return label }
            return "Pre-owned, good condition"
        }()
        let vars: [String: String] = [
            "brand": facts.brand.trimmingCharacters(in: .whitespacesAndNewlines),
            "title": facts.title.trimmingCharacters(in: .whitespacesAndNewlines),
            "size": placeholder(facts.size),
            "color": placeholder(facts.color),
            "material": placeholder(facts.material),
            "condition": condition,
        ]

        var out = template
        for (key, value) in vars {
            out = out.replacingOccurrences(of: "{{" + key + "}}", with: value)
        }
        // Collapse the gaps an empty variable leaves behind, then trim.
        out = out.replacingOccurrences(
            of: "\n{3,}", with: "\n\n", options: .regularExpression
        )
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Pick the group's template and fill it. The one call a caller needs.
    static func build(facts: Facts) -> String {
        interpolate(template: template(for: group(for: facts)), facts: facts)
    }

    // MARK: - Helpers

    /// Web parity: an unset attribute renders as an em dash rather than an empty
    /// line, so the buyer can see the field was considered.
    private static func placeholder(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "\u{2014}" : trimmed
    }
}
