import Foundation

/// US-2818 - the Swift mirror of `src/lib/listing-templates.ts`.
///
/// The buyer-facing description iOS wrote came from one place: the AI's
/// free-form `/listing-copy` answer in the publish dialog. The web composer has
/// had a structured, per-garment template since US-827 - an opening line, the
/// attributes, an honest condition statement, the flat measurements with their
/// worn equivalents, and the grade line - and that structure is most of why the
/// web copy reads better. None of it needs a network call or a model.
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
    static func template(for group: GarmentGroup) -> String {
        switch group {
        case .top:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Measurements (garment laid flat):
            {{measurements}}

            {{grade}}
            Smoke-free home. Ships fast. Questions welcome.
            """
        case .bottom, .dress, .outerwear:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Measurements (laid flat):
            {{measurements}}

            {{grade}}
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

            Sold as a two-piece set - jacket and trousers together.

            Measurements (each piece laid flat):
            {{measurements}}

            {{grade}}
            Smoke-free home. Ships fast. Questions welcome.
            """
        case .shoes:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}

            Condition: {{condition}}

            {{measurements}}

            {{grade}}
            Smoke-free home. Ships fast. Questions welcome.
            """
        case .watch:
            return """
            {{brand}} {{title}}

            Condition: {{condition}}

            Specs:
            {{measurements}}

            {{grade}}
            Ships insured. Questions welcome.
            """
        case .headwear:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Measurements:
            {{measurements}}

            {{grade}}
            Smoke-free home. Ships fast. Questions welcome.
            """
        case .accessory:
            return """
            {{brand}} {{title}}

            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Measurements:
            {{measurements}}

            {{grade}}
            Smoke-free home. Ships fast. Questions welcome.
            """
        case .bag:
            return """
            {{brand}} {{title}}

            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            Measurements:
            {{measurements}}

            {{grade}}
            Comes from a smoke-free home. Ships boxed. Questions welcome.
            """
        case .generic:
            return """
            {{brand}} {{title}}

            Size: {{size}}
            Color: {{color}}
            Material: {{material}}

            Condition: {{condition}}

            {{measurements}}

            {{grade}}
            Smoke-free home. Ships fast. Questions welcome.
            """
        }
    }

    // MARK: - Measurements

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

    /// The indented block the `{{measurements}}` placeholder becomes.
    static func measurementsBlock(
        _ measurements: [String: Double],
        unit: MeasurementUnit
    ) -> String {
        let lines = measurementLines(measurements, unit: unit)
        if lines.isEmpty { return "(measurements available on request)" }
        return lines.map { "  " + $0 }.joined(separator: "\n")
    }

    // MARK: - Grade line

    /// Plain text, NO URL - eBay bans off-eBay links in listings. The PSA-style
    /// certificate NUMBER is appended server-side at publish
    /// (flipdesk-ebay.ts applyGradeListingPromotion), because the unique number
    /// lives on the grade report rather than on the item row.
    static func gradeBlock(gradeValue: Double?) -> String {
        guard let gradeValue else { return "" }
        return String(
            format: "Graded by GradeThread - Condition Grade %.1f", gradeValue
        )
    }

    /// Idempotently ensure the grade line is present. An AI rewrite - especially
    /// "regenerate" - writes a fresh description that drops the grade line, and
    /// the seller's preview would then show no grade even though publish
    /// re-asserts it. Keys on the "Condition Grade" phrase, the same anchor the
    /// server's `appendCertNumber` uses.
    static func ensureGradeLine(_ description: String, gradeValue: Double?) -> String {
        let block = gradeBlock(gradeValue: gradeValue)
        guard !block.isEmpty else { return description }
        guard description.range(of: "Condition Grade", options: .caseInsensitive) == nil
        else { return description }
        let trimmed = trimTrailingWhitespace(description)
        return trimmed.isEmpty ? block : trimmed + "\n\n" + block
    }

    // MARK: - Seller credentials block

    /// The GradeThread "Verified Seller" block is appended server-side (edge
    /// `ai-listing.ts`) behind this HTML comment marker. Keep the literal in
    /// lockstep with the edge injection and the web `SELLER_CREDENTIALS_MARKER`.
    static let sellerCredentialsMarker = "<!--gradethread-seller-credentials-->"

    /// Split a description into its plain body and the trailing credentials
    /// block. Everything from the marker on is the block - it is always last.
    static func splitSellerCredentials(
        _ description: String
    ) -> (body: String, credentials: String) {
        guard let range = description.range(of: sellerCredentialsMarker) else {
            return (description, "")
        }
        return (
            trimTrailingWhitespace(String(description[..<range.lowerBound])),
            String(description[range.lowerBound...])
        )
    }

    /// Idempotently preserve the credentials block across an AI rewrite: strip
    /// any marker the model echoed into the new copy, then re-append the
    /// ORIGINAL block verbatim. No-op when the original had none.
    static func ensureSellerCredentials(_ next: String, original: String) -> String {
        let credentials = splitSellerCredentials(original).credentials
        let cleaned = splitSellerCredentials(next).body
        guard !credentials.isEmpty else { return cleaned }
        let trimmed = trimTrailingWhitespace(cleaned)
        return trimmed.isEmpty ? credentials : trimmed + "\n" + credentials
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

    /// Pick the string that should decide the template, most-specific-first.
    /// Mirrors the web `garmentDescriptorFor`: a candidate only wins if it
    /// resolves to a real group, so `item_category`'s literal "clothing" is
    /// skipped rather than swallowing the answer, and the title is a genuine
    /// last resort ("Vintage Levi's 550 Denim Shorts" beats nothing).
    static func garmentDescriptor(
        garmentCategory: String?,
        garmentType: String?,
        itemCategory: String?,
        style: String?,
        title: String?
    ) -> String {
        let candidates = [garmentCategory, garmentType, itemCategory, style, title]
            .map { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        for candidate in candidates
        where !coarseVerticals.contains(candidate.lowercased())
            && GarmentGroup.from(candidate) != .generic {
            return candidate
        }
        for candidate in candidates where GarmentGroup.from(candidate) != .generic {
            return candidate
        }
        return candidates.first ?? ""
    }

    /// Fill one template. Mirrors the web `interpolateDescription`, with one
    /// deliberate improvement: the web fills `color` and `material` with an
    /// em-dash placeholder because `items_full` exposes neither column, and iOS
    /// reads the item row directly - so it fills the real values and falls back
    /// to the placeholder only when the field is genuinely blank.
    static func interpolate(
        template: String,
        facts: Facts,
        unit: MeasurementUnit = AppPreferences.measurementUnit
    ) -> String {
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
            "measurements": measurementsBlock(facts.measurements, unit: unit),
            "grade": gradeBlock(gradeValue: facts.gradeValue),
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
    static func build(
        facts: Facts,
        unit: MeasurementUnit = AppPreferences.measurementUnit
    ) -> String {
        interpolate(
            template: template(for: group(for: facts)), facts: facts, unit: unit
        )
    }

    // MARK: - Helpers

    /// Web parity: an unset attribute renders as an em dash rather than an empty
    /// line, so the buyer can see the field was considered.
    private static func placeholder(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "\u{2014}" : trimmed
    }

    private static func trimTrailingWhitespace(_ value: String) -> String {
        var out = value
        while let last = out.last, last.isWhitespace || last.isNewline {
            out.removeLast()
        }
        return out
    }
}
