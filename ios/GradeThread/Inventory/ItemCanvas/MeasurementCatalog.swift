import Foundation

/// Swift mirror of the canonical measurement keys in `src/lib/measurements.ts`
/// and the category templates in `src/lib/measurement-templates.ts`. Garment
/// measurements live on `inventory_items.measurements` (jsonb) keyed by these
/// canonical keys; LENGTH values are flat measurements in INCHES, shoe sizes are
/// US numeric, watch dimensions are millimetres. Keep this in sync with the web
/// copies (pure data — no behavior to drift).
enum MeasurementCatalog {
    enum Kind: Equatable {
        case length  // inches
        case shoe    // US numeric
        case mm      // millimetres

        /// Short unit shown after the value (and as the field placeholder).
        var unitSuffix: String {
            switch self {
            case .length: return "in"
            case .shoe: return "US"
            case .mm: return "mm"
            }
        }
    }

    struct Spec: Equatable {
        let key: String
        let label: String
        let kind: Kind
    }

    /// Canonical key → spec, in the order they should render. Mirrors
    /// `MEASUREMENT_SPECS`.
    static let specs: [Spec] = [
        Spec(key: "chest", label: "Chest (pit to pit)", kind: .length),
        Spec(key: "bust", label: "Bust", kind: .length),
        Spec(key: "waist", label: "Waist (flat)", kind: .length),
        Spec(key: "hip", label: "Hip", kind: .length),
        Spec(key: "inseam", label: "Inseam", kind: .length),
        Spec(key: "rise", label: "Front rise", kind: .length),
        Spec(key: "leg_opening", label: "Leg opening", kind: .length),
        Spec(key: "sleeve", label: "Sleeve", kind: .length),
        Spec(key: "shoulder", label: "Shoulder", kind: .length),
        Spec(key: "length", label: "Length", kind: .length),
        Spec(key: "width", label: "Width", kind: .length),
        Spec(key: "insole", label: "Insole length", kind: .length),
        Spec(key: "size_us", label: "US size", kind: .shoe),
        Spec(key: "case_diameter", label: "Case diameter", kind: .mm),
        Spec(key: "lug_width", label: "Lug width", kind: .mm),
        Spec(key: "band_length", label: "Band length", kind: .mm),
    ]

    private static let byKey: [String: Spec] = Dictionary(
        specs.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a }
    )

    /// Human label for a key (de-underscored fallback for non-canonical keys).
    static func label(for key: String) -> String {
        byKey[key]?.label ?? key.replacingOccurrences(of: "_", with: " ").capitalized
    }

    /// Measurement kind for a key (length for unknown keys — the common case).
    static func kind(for key: String) -> Kind {
        byKey[key]?.kind ?? .length
    }

    /// The canonical keys suggested for a coarse item category, used to seed the
    /// "Add measurement" menu with the most relevant fields first. Mirrors
    /// `measurementGroupFor` against `inventory_items.item_category` values.
    static func suggestedKeys(forCategory category: String?) -> [String] {
        switch (category ?? "").lowercased() {
        case "shoes", "footwear":
            return ["size_us", "insole"]
        case "watches", "watch":
            return ["case_diameter", "lug_width", "band_length"]
        case "accessories", "bags", "other":
            return ["length", "width"]
        default:
            // Clothing and anything uncategorized: the common garment set.
            return ["chest", "length", "shoulder", "sleeve", "waist", "inseam", "rise", "hip"]
        }
    }

    /// Order a set of measurement keys: canonical keys in catalog order first,
    /// then any non-canonical keys alphabetically.
    static func ordered<S: Sequence>(_ keys: S) -> [String] where S.Element == String {
        let present = Set(keys)
        let canonical = specs.map(\.key).filter(present.contains)
        let extras = present.subtracting(canonical).sorted()
        return canonical + extras
    }

    /// Format a stored value for the badge/suffix-free display (trims trailing
    /// ".0"). Pure.
    static func trimmed(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }

    /// Locale-aware decimal formatter for the editable measurement field. Both
    /// the display (get) and parse (set) route through this so the round-trip is
    /// consistent in comma-decimal locales — US-1491: a raw `Double(cleaned)`
    /// dropped the fraction of "18,5" (→ nil) in de/fr/es, and a "."-formatted
    /// display re-parsed as grouping (185). No grouping separator so the field
    /// only ever shows the value + locale decimal separator.
    /// `locale` is injectable so tests can exercise a comma-decimal locale
    /// (de_DE); production always uses `.current`.
    static func editFormatter(locale: Locale = .current) -> NumberFormatter {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = locale
        f.usesGroupingSeparator = false
        f.maximumFractionDigits = 2
        f.minimumFractionDigits = 0
        return f
    }

    /// Display a stored value in the editable field, locale-formatted (trims
    /// trailing zeros). Empty string for a non-positive/unset value.
    static func editableString(_ value: Double, locale: Locale = .current) -> String {
        guard value > 0 else { return "" }
        return editFormatter(locale: locale).string(from: NSNumber(value: value)) ?? trimmed(value)
    }

    /// Parse user-entered measurement text with the locale decimal separator.
    /// Returns nil for empty/unparseable input.
    static func parse(_ input: String, locale: Locale = .current) -> Double? {
        let trimmedInput = input.trimmingCharacters(in: .whitespaces)
        guard !trimmedInput.isEmpty else { return nil }
        return editFormatter(locale: locale).number(from: trimmedInput)?.doubleValue
    }
}
