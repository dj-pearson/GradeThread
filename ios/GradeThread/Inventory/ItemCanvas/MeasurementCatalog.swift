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
        // US-2812: bags, belts and headwear. These existed on the web and in
        // no native catalog, so suggestedKeys could not offer them and a key
        // arriving from the server rendered with an auto-derived label.
        Spec(key: "height", label: "Height", kind: .length),
        Spec(key: "depth", label: "Depth", kind: .length),
        Spec(key: "strap_drop", label: "Strap drop", kind: .length),
        Spec(key: "handle_drop", label: "Handle drop", kind: .length),
        Spec(key: "hole_span", label: "First to last hole (belts)", kind: .length),
        Spec(key: "circumference", label: "Head circumference (inside)", kind: .length),
        Spec(key: "crown_height", label: "Crown height", kind: .length),
        Spec(key: "brim_length", label: "Brim length", kind: .length),
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
        // US-2812: bags and accessories shared a branch returning length+width,
        // and there was no headwear branch at all — so a hat fell to `default`
        // and was offered a chest, a sleeve and an INSEAM. Harmless until
        // US-2797 made `headwear` a producible item_category.
        case "bags":
            return ["width", "height", "depth", "strap_drop", "handle_drop"]
        case "accessories":
            return ["length", "width", "hole_span"]
        case "headwear":
            return ["circumference", "crown_height", "brim_length"]
        case "other":
            return ["length", "width"]
        default:
            // Clothing and anything uncategorized: the common garment set.
            // CLOTHING STAYS FLAT, deliberately — the web splits it five ways
            // by resolving a GARMENT word, and this function only has the
            // coarse item_category, which cannot tell a blazer from jeans.
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

/// US-2920: does the size on the label agree with what the garment measures?
///
/// The MATH is not here. `GET /api/flipdesk/size-bands` turns the brand's
/// body-measurement chart into the flat range a garment of each size should
/// show — adding garment ease and halving the circumference — and returns a
/// small table. This type does the LOOKUP against that table, which is what has
/// to run on every keystroke while somebody measures with one hand.
///
/// It is a Swift copy of `src/lib/size-check.ts`, and it runs the SAME two
/// fixture cases the edge, web and Android suites run
/// (`GradeThreadTests/SizeCheckTests.swift`), so the four copies cannot drift
/// apart without a red test somewhere.
///
/// Pure: no network, no state, no side effects.
enum SizeCheck {
    // MARK: - The endpoint's response

    struct BandRow: Decodable, Equatable {
        let size: String
        let index: Int
        /// Measurement key → [low, high] expected FLAT inches.
        let bands: [String: [Double]]
    }

    struct BandsResponse: Decodable, Equatable {
        let tier: String
        let brandLabel: String?
        let department: String?
        let garment: String?
        let sourceUrl: String?
        let sizeSystem: String?
        let sizeClass: String?
        let measurementBasis: String
        let rows: [BandRow]

        /// What every "we have nothing to say" path returns. A failed fetch is
        /// not an error state here: the check is an assist, and a brand with no
        /// chart on file looks exactly the same to the seller.
        static let empty = BandsResponse(
            tier: "none",
            brandLabel: nil,
            department: nil,
            garment: nil,
            sourceUrl: nil,
            sizeSystem: nil,
            sizeClass: nil,
            measurementBasis: "body",
            rows: []
        )
    }

    // MARK: - The verdict

    enum Status: String, Equatable {
        case ok
        case off
        case unknown
    }

    struct Verdict: Equatable {
        let status: Status
        /// What the measurements point at ("XS", or "smaller than XS").
        let impliedSize: String?
        /// Size steps between the label and the implied size. 0 when they agree.
        let stepsOff: Int
        /// The measurement driving the verdict.
        let key: String?
        /// The labelled size's own band for that key.
        let expected: [Double]?

        static let unknown = Verdict(
            status: .unknown, impliedSize: nil, stepsOff: 0, key: nil, expected: nil
        )
    }

    /// The keys a band can be built for, in the order they are judged.
    static let bandKeys = ["chest", "bust", "waist", "hip", "inseam"]

    /// Which item measurement answers a band key. A top's flat pit-to-pit is
    /// stored as `chest` whatever the chart calls it; nothing else substitutes.
    private static let measurementAliases: [String: [String]] = [
        "chest": ["chest", "bust"],
        "bust": ["bust", "chest"],
        "waist": ["waist"],
        "hip": ["hip", "hips"],
        "inseam": ["inseam"]
    ]

    /// Size steps required before a disagreement is worth saying out loud: one
    /// on a chart a human checked against the brand's own guide, two on a
    /// generic fallback that is an estimate and says so.
    static func tolerance(forTier tier: String) -> Int {
        tier == "generic" ? 2 : 1
    }

    // MARK: - Matching a size label to a row

    private static let alphaWords: [(String, String)] = [
        ("extra extra extra", "xxx"),
        ("extra extra", "xx"),
        ("extra", "x"),
        ("double", "xx"),
        ("triple", "xxx"),
        ("small", "s"),
        ("medium", "m"),
        ("med", "m"),
        ("large", "l")
    ]

    private static let systemPrefixes = ["uk", "eu", "it", "fr", "jp", "au", "us", "de"]

    /// A bare number matches only bare numbers; a prefixed one keeps its system.
    /// A UK 12 and a US 12 are two different garments, and the corpus warns that
    /// treating them as one is the costliest mistake on a UK-sized brand.
    private static func numericAlias(prefix: String, _ text: String) -> String {
        let value = Double(text) ?? 0
        let normalized = value == value.rounded()
            ? String(Int(value))
            : String(value)
        return (prefix.isEmpty || prefix == "us") ? normalized : prefix + normalized
    }

    private static func aliases(forPart part: String) -> [String] {
        var text = part.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !text.isEmpty else { return [] }
        for character in ["(", ")", "."] {
            text = text.replacingOccurrences(of: character, with: " ")
        }
        text = text.split(separator: " ").joined(separator: " ")
        for (word, replacement) in alphaWords {
            text = text.replacingOccurrences(of: word, with: replacement)
        }
        // Drop spaces, and hyphens that do not join two numbers ("x-large" is
        // one size; "16-18" is a range of two).
        var squeezed = ""
        let characters = Array(text)
        for (i, character) in characters.enumerated() {
            if character == " " { continue }
            if character == "-" {
                let next = i + 1 < characters.count ? characters[i + 1] : Character(" ")
                if !next.isNumber { continue }
            }
            squeezed.append(character)
        }
        text = squeezed

        var prefix = ""
        for candidate in systemPrefixes where text.hasPrefix(candidate) {
            let rest = String(text.dropFirst(candidate.count))
            if let first = rest.first, first.isNumber {
                prefix = candidate
                text = rest
                break
            }
        }

        // "16-18" in "UK 16-18 / XL": both numbers name the same row.
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        if parts.count == 2, isNumeric(String(parts[0])), isNumeric(String(parts[1])) {
            return parts.map { numericAlias(prefix: prefix, String($0)) }
        }
        if isNumeric(text) {
            return [numericAlias(prefix: prefix, text)]
        }
        // "2xl" / "3x" → "xxl" / "xxxl".
        if let multi = multiAlias(text) {
            return [multi]
        }
        if isAlphaSize(text) {
            return [text]
        }
        // A waist-in-inches tag ("W30") is also written as the bare number by
        // half the sellers on the platform; both spellings name the same row.
        if text.hasPrefix("w"), isNumeric(String(text.dropFirst())) {
            return [text, numericAlias(prefix: "", String(text.dropFirst()))]
        }
        return text.isEmpty ? [] : [prefix + text]
    }

    private static func isNumeric(_ text: String) -> Bool {
        !text.isEmpty && Double(text) != nil
    }

    /// `x*[sml]`: xs, s, m, l, xl, xxl, xxxl.
    private static func isAlphaSize(_ text: String) -> Bool {
        guard let last = text.last, "sml".contains(last) else { return false }
        return text.dropLast().allSatisfy { $0 == "x" }
    }

    private static func multiAlias(_ text: String) -> String? {
        let characters = Array(text)
        guard let first = characters.first, let count = first.wholeNumberValue,
              count >= 1, count <= 5,
              characters.count >= 2, characters[1] == "x" else { return nil }
        let tail = characters.count == 3 ? String(characters[2]) : "l"
        guard characters.count <= 3, "sl".contains(tail) else { return nil }
        return String(repeating: "x", count: count) + tail
    }

    private static func aliases(forLabel label: String) -> Set<String> {
        var out: Set<String> = []
        let separators = CharacterSet(charactersIn: "/,|")
        for part in label.components(separatedBy: separators) {
            for alias in aliases(forPart: part) { out.insert(alias) }
        }
        return out
    }

    /// Where an item's size text sits in the band table, or nil when nothing
    /// matches. Never falls back to row 0 — a size we cannot place is a size we
    /// do not judge, and guessing "the first row" would flag the whole chart.
    static func resolveRow(_ rows: [BandRow], size: String?) -> Int? {
        guard let size, !size.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        let want = aliases(forLabel: size)
        guard !want.isEmpty else { return nil }
        for row in rows where !aliases(forLabel: row.size).isDisjoint(with: want) {
            return row.index
        }
        return nil
    }

    // MARK: - The check

    private struct KeyVerdict {
        let key: String
        let stepsOff: Int
        let impliedSize: String
        let expected: [Double]?
    }

    private static func measurement(
        _ measurements: [String: Double], forKey key: String
    ) -> Double? {
        for alias in measurementAliases[key] ?? [] {
            if let value = measurements[alias], value > 0 { return value }
        }
        return nil
    }

    private static func edgeDistance(_ band: [Double], _ value: Double) -> Double {
        guard band.count == 2 else { return .greatestFiniteMagnitude }
        if value < band[0] { return band[0] - value }
        if value > band[1] { return value - band[1] }
        return 0
    }

    private static func judge(
        rows: [BandRow], rowIndex: Int, key: String, value: Double
    ) -> KeyVerdict? {
        let withBand = rows.filter { ($0.bands[key]?.count ?? 0) == 2 }
        guard let smallest = withBand.first, let largest = withBand.last else { return nil }
        let expected = rows.first { $0.index == rowIndex }?.bands[key]

        let containing = withBand.filter { row in
            guard let band = row.bands[key] else { return false }
            return value >= band[0] && value <= band[1]
        }
        if !containing.isEmpty {
            let nearest = containing.min {
                abs($0.index - rowIndex) < abs($1.index - rowIndex)
            }
            guard let nearest else { return nil }
            return KeyVerdict(
                key: key,
                stepsOff: abs(nearest.index - rowIndex),
                impliedSize: nearest.size,
                expected: expected
            )
        }

        // Off the end of the chart. Naming the edge is the whole point of the
        // motivating case: a 17.5 in flat chest is not "an XS", it is below
        // every size the brand makes, and saying so is more useful than the
        // nearest row's name.
        if let band = smallest.bands[key], value < band[0] {
            return KeyVerdict(
                key: key,
                stepsOff: rowIndex - (smallest.index - 1),
                impliedSize: "smaller than \(smallest.size)",
                expected: expected
            )
        }
        if let band = largest.bands[key], value > band[1] {
            return KeyVerdict(
                key: key,
                stepsOff: largest.index + 1 - rowIndex,
                impliedSize: "larger than \(largest.size)",
                expected: expected
            )
        }

        // In a gap between two bands: take the closer edge.
        let nearest = withBand.min {
            edgeDistance($0.bands[key] ?? [], value) < edgeDistance($1.bands[key] ?? [], value)
        }
        guard let nearest else { return nil }
        return KeyVerdict(
            key: key,
            stepsOff: abs(nearest.index - rowIndex),
            impliedSize: nearest.size,
            expected: expected
        )
    }

    /// Does the item's own measurement agree with the size on its label?
    ///
    /// When more than one key can be judged, the one with the LARGEST
    /// disagreement wins, so the note names the measurement actually driving it
    /// rather than the first one that happened to have a band.
    static func check(
        rows: [BandRow], rowIndex: Int?, measurements: [String: Double], tier: String
    ) -> Verdict {
        guard let rowIndex, !rows.isEmpty, tier != "none" else { return .unknown }
        guard rows.contains(where: { $0.index == rowIndex }) else { return .unknown }

        var verdicts: [KeyVerdict] = []
        for key in bandKeys {
            guard let value = measurement(measurements, forKey: key) else { continue }
            if let verdict = judge(rows: rows, rowIndex: rowIndex, key: key, value: value) {
                verdicts.append(verdict)
            }
        }
        // FIRST strict maximum, not `max(by:)`, which returns the LAST of a
        // tie. The other three copies take the first, and a tie between chest
        // and waist would otherwise name a different measurement on iOS than on
        // the web for the same garment.
        var worst: KeyVerdict?
        for verdict in verdicts where verdict.stepsOff > (worst?.stepsOff ?? -1) {
            worst = verdict
        }
        guard let worst else { return .unknown }
        return Verdict(
            status: worst.stepsOff >= tolerance(forTier: tier) ? .off : .ok,
            impliedSize: worst.impliedSize,
            stepsOff: worst.stepsOff,
            key: worst.key,
            expected: worst.expected
        )
    }

    // MARK: - Copy

    /// The size a "Change to …" action would write, or nil when there is
    /// nothing to write. An edge verdict names a size the brand does not make,
    /// so there is no one-click fix for it — the seller has to decide.
    static func fixableSize(_ verdict: Verdict) -> String? {
        guard verdict.status == .off, let implied = verdict.impliedSize else { return nil }
        if implied.hasPrefix("smaller than ") || implied.hasPrefix("larger than ") {
            return nil
        }
        return implied
    }

    /// "Measurements point to XS, not Large. A Large usually measures 22 to 26.5 in here."
    static func note(_ verdict: Verdict, labelled: String) -> String {
        guard let implied = verdict.impliedSize else { return "" }
        var text = "Measurements point to \(implied), not \(labelled)."
        if let expected = verdict.expected, expected.count == 2 {
            text += " A \(labelled) usually measures "
            text += "\(MeasurementCatalog.trimmed(expected[0])) to "
            text += "\(MeasurementCatalog.trimmed(expected[1])) in here."
        }
        return text
    }

    /// The department a chart is resolved by, read off the item's own text.
    ///
    /// Mirrors `inferDepartment` in `src/lib/ebay-prefill.ts`, narrowed to the
    /// two the endpoint accepts. Everything else returns nil, and nil is a fine
    /// answer: the endpoint drops to a generic chart rather than guessing a
    /// department, so a wrong guess here is strictly worse than none.
    static func department(fromText parts: [String?]) -> String? {
        let text = parts.compactMap { $0 }.joined(separator: " ").lowercased()
        guard !text.isEmpty else { return nil }
        // Most specific first, and women before men so "women" is not read as
        // the "men" inside it.
        let kidsMarkers = ["baby", "infant", "newborn", "toddler", "boys", "girls",
                           "kids", "youth", "junior", "children", "maternity"]
        for marker in kidsMarkers where text.contains(marker) {
            return nil
        }
        for marker in ["women", "woman", "ladies", "female", "misses"] where text.contains(marker) {
            return "Women"
        }
        for marker in ["mens", "men's", "men ", "menswear", "male"] where text.contains(marker) {
            return "Men"
        }
        return nil
    }

    /// What the seller should know about the chart behind the note. A generic
    /// chart is an estimate and must say so: US-2915 accepted that this check
    /// catches gross errors and stays quiet on subtle ones, and a note that
    /// hides which kind of chart it used cannot be judged by its reader.
    static func tierNote(tier: String, brand: String?) -> String? {
        guard tier == "generic" else { return nil }
        if let brand, !brand.isEmpty {
            return "Estimate only — no \(brand) chart on file."
        }
        return "Estimate only — no brand chart on file."
    }
}
