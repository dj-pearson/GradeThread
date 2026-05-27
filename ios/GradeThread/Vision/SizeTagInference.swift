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
        // 1. Known-brand whitelist — substring match against the joined
        //    lowercase form so multi-word brands ('the north face') don't
        //    get split.
        let joinedLower = lines.joined(separator: " ").lowercased()
        for brand in knownBrands {
            if joinedLower.contains(brand) {
                return brand
                    .split(separator: " ")
                    .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                    .joined(separator: " ")
            }
        }

        // 2. Uppercase heuristic — the first line that's 2–25 chars,
        //    >=70% uppercase letters, and isn't size-y (avoids matching
        //    "SIZE M" or "MADE IN USA" as a brand). Care-tag brands are
        //    almost always printed in caps at the top.
        for line in lines.prefix(4) {
            let letters = line.filter { $0.isLetter || $0 == "'" || $0 == "." || $0 == " " }
            guard letters.count >= 2, letters.count <= 25 else { continue }
            let uppercase = letters.filter { $0.isUppercase || !$0.isLetter }
            let uppercaseRatio = letters.isEmpty ? 0 : Double(uppercase.count) / Double(letters.count)
            guard uppercaseRatio >= 0.7 else { continue }
            // Reject lines that read as care/size instructions.
            let lower = line.lowercased()
            if lower.contains("size") || lower.contains("made in") || lower.contains("wash") {
                continue
            }
            // Reject lines that are just alpha-size tokens.
            if alphaSizes.contains(line.uppercased()) { continue }
            return line.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return nil
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

    /// "30 x 32", "30x32", "W30 L32" → "30x32".
    static func matchWaistLength(_ line: String) -> String? {
        let pattern = #"(?i)\bW?(\d{2})\s*[xX×]\s*L?(\d{2})\b"#
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
        if let n = Int(raw), n >= 0, n <= 60 { return raw }
        return nil
    }

    /// Bare alpha size on its own line: "M", "XL".
    static func matchAlphaSize(_ line: String) -> String? {
        let upper = line.uppercased().trimmingCharacters(in: .whitespaces)
        return alphaSizes.contains(upper) ? upper : nil
    }

    /// Bare numeric size 0–60 on its own line — defensive on the upper
    /// bound to avoid matching dates or batch numbers.
    static func matchNumericSize(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let n = Int(trimmed), n >= 0, n <= 60 else { return nil }
        return String(n)
    }
}
