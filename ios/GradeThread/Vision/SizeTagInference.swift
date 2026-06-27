import Foundation

/// Heuristic brand + size extraction from OCR'd tag lines.
///
/// On-device OCR returns raw strings. Most care tags follow predictable
/// conventions: brand at top in caps, size somewhere below (alpha-size
/// like "M", numeric like "32", or waist×length like "30 x 32"). This
/// is intentionally simple — when AI extraction can run we prefer its
/// suggestions; this fallback only fires when AI didn't return a value
/// for one of these specific fields.
enum SizeTagInference {

    /// Parsed result. Either field may be nil when the heuristics didn't
    /// find a confident candidate.
    struct Result: Equatable {
        var brand: String?
        var size: String?
    }

    /// Lowercase brand tokens we recognise. Hits short-circuit the
    /// uppercase heuristic since some real brands ('adidas', 'lululemon')
    /// print lowercase on their tags. List intentionally short — better
    /// to miss than misidentify.
    static let knownBrands: Set<String> = [
        "patagonia", "the north face", "north face",
        "nike", "adidas", "puma", "new balance", "reebok",
        "levi's", "levis", "lee", "wrangler", "dickies",
        "carhartt", "filson", "pendleton",
        "polo ralph lauren", "ralph lauren", "lacoste", "tommy hilfiger",
        "j crew", "j.crew", "jcrew", "banana republic", "gap",
        "uniqlo", "muji",
        "lululemon", "athleta",
        "supreme", "stussy", "stüssy", "bape",
        "champion", "fila",
        "calvin klein", "diesel", "guess",
        "burberry", "gucci", "prada", "louis vuitton",
        "vineyard vines", "brooks brothers",
    ]

    /// Alpha-size tokens we recognise verbatim. Order matters for the
    /// regex matcher — "XXL" must come before "XL" before "L".
    static let alphaSizes: [String] = [
        "XXXL", "XXL", "XL", "L", "M", "S", "XS", "XXS",
    ]

    static func infer(lines: [String]) -> Result {
        var result = Result()
        let normalized = lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        result.brand = detectBrand(in: normalized)
        result.size = detectSize(in: normalized)
        return result
    }

    // MARK: - Brand

    static func detectBrand(in lines: [String]) -> String? {
        // Known-brand whitelist ONLY — matched on tokenized WORD BOUNDARIES
        // against the joined lowercase form, NOT a naked substring `contains`.
        // A substring match misfires on common fabric/care words ("fleece"
        // contains "lee", "supremely" contains "supreme"); a `\b…\b` match
        // requires the brand to stand as its own token(s), so "fleece" no
        // longer infers the brand "Lee". Multi-word brands ('the north face')
        // match across whitespace runs. Pick the LONGEST match: `knownBrands`
        // is a Set with overlapping entries ('north face' ⊂ 'the north face',
        // 'levis' ⊂ "levi's"), and iterating it in hash order would return a
        // non-deterministic, often-truncated brand.
        //
        // We intentionally do NOT fall back to a "first prominent uppercase
        // line" heuristic: on a real care/brand tag that line is just as often a
        // COLLECTION or STYLE name ("BETTER SWEATER", "HERITAGE", a model name)
        // as the brand, so the heuristic confidently surfaced a style name AS
        // the brand — exactly the OCR garbage this fallback should avoid. When
        // OCR can't match a known brand, return nil (leave brand empty) rather
        // than guess; Claude Vision is the primary brand source and the canvas
        // still lets the user fill it.
        let joinedLower = lines.joined(separator: " ").lowercased()
        guard let brand = knownBrands
            .filter({ brandMatches($0, in: joinedLower) })
            .max(by: { $0.count < $1.count })
        else { return nil }
        return brand
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// True when `brand` appears in `haystack` (already lowercased) on
    /// tokenized word boundaries — so "lee" matches "lee" / "lee jeans" but
    /// NOT the "lee" inside "fleece". Whitespace inside a multi-word brand
    /// matches any whitespace run; punctuation in a brand ("levi's", "j.crew")
    /// is matched literally.
    static func brandMatches(_ brand: String, in haystack: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: brand)
            .replacingOccurrences(of: " ", with: #"\s+"#)
        let pattern = #"\b"# + escaped + #"\b"#
        guard let regex = try? NSRegularExpression(
            pattern: pattern,
            options: [.caseInsensitive]
        ) else { return false }
        let range = NSRange(haystack.startIndex..<haystack.endIndex, in: haystack)
        return regex.firstMatch(in: haystack, range: range) != nil
    }

    // MARK: - Size

    static func detectSize(in lines: [String]) -> String? {
        for line in lines {
            if let size = matchWaistLength(line) { return size }
        }
        for line in lines {
            if let size = matchExplicitSize(line) { return size }
        }
        for line in lines {
            if let size = matchAlphaSize(line) { return size }
        }
        for line in lines {
            if let size = matchNumericSize(line) { return size }
        }
        return nil
    }

    /// "30 x 32", "30x32", "W30 L32", "W30L32" → "30x32". Two separator
    /// forms: an explicit x/× (optionally with W/L prefixes), or the
    /// prefix-only jeans form where an `L` stands in for the separator
    /// ("W34 L32" has no x).
    static func matchWaistLength(_ line: String) -> String? {
        let pattern = #"(?i)\bW?(\d{2})\s*(?:[xX×]\s*L?|L)(\d{2})\b"#
        guard
            let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(
                in: line,
                range: NSRange(line.startIndex..<line.endIndex, in: line)
            ),
            let waistRange = Range(match.range(at: 1), in: line),
            let lengthRange = Range(match.range(at: 2), in: line)
        else { return nil }
        let waist = String(line[waistRange])
        let length = String(line[lengthRange])
        guard let w = Int(waist), w >= 22, w <= 60 else { return nil }
        guard let l = Int(length), l >= 24, l <= 40 else { return nil }
        return "\(waist)x\(length)"
    }

    /// "Size 12", "SIZE M".
    static func matchExplicitSize(_ line: String) -> String? {
        let pattern = #"(?i)\bsize\s*[:#]?\s*(\S{1,5})\b"#
        guard
            let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(
                in: line,
                range: NSRange(line.startIndex..<line.endIndex, in: line)
            ),
            let valueRange = Range(match.range(at: 1), in: line)
        else { return nil }
        let raw = String(line[valueRange]).uppercased()
        if alphaSizes.contains(raw) { return raw }
        // Require n >= 1: a bare "0" here is far more often a care-symbol code
        // or OCR noise than a real explicit size annotation.
        if let n = Int(raw), n >= 1, n <= 60 { return raw }
        return nil
    }

    /// Bare alpha size on its own line: "M", "XL".
    static func matchAlphaSize(_ line: String) -> String? {
        let upper = line.uppercased().trimmingCharacters(in: .whitespaces)
        return alphaSizes.contains(upper) ? upper : nil
    }

    /// Bare numeric size on its own line, constrained to a plausible clothing
    /// size range (1–54). A bare line is the LEAST confident size signal, so
    /// the bounds are deliberately tight: the lower bound rejects a stray "0"
    /// (a care code, not a size), and the upper bound rejects years/batch/lot
    /// numbers ("2024") and other large care codes.
    static func matchNumericSize(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let n = Int(trimmed), n >= 1, n <= 54 else { return nil }
        return String(n)
    }
}
