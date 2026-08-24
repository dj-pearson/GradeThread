import Foundation

/// What a listing title is carrying, and what is wrong with it.
///
/// LOCKSTEP MIRROR of the web `src/lib/title-quality.ts` (US-2680). Same cap,
/// same non-searchable words, same lint rules, same bands. Two apps that judge
/// the same title differently are worse than one app that judges it at all, so
/// when that file changes this one changes with it.
///
/// iOS shipped the title as a bare text box: no character counter against
/// eBay's hard 80, no sense of what the title added, no lint. A seller could
/// type past the cap and watch eBay truncate it, or pad it with words their
/// item specifics already carried and believe they had helped.
enum TitleQuality {

    /// eBay's hard cap. A LIMIT, never a target -- there is no length to aim
    /// for, and the web card says so in as many words.
    static let maxLength = 80

    /// Enough distinct terms to match a spread of queries.
    static let termGreenMin = 6
    /// Below this a title is too thin to match many queries at all.
    static let termWeakBelow = 4

    // MARK: - Terms

    /// Words that occupy characters and add no retrievable meaning. Smaller
    /// than a search stopword list on purpose: this one only needs to catch
    /// what a seller types to fill space.
    static let nonSearchable: Set<String> = [
        "the", "and", "for", "with", "your", "you", "this", "that", "all",
        "in", "of", "to", "a", "an", "or", "by", "on", "at", "is", "it", "from",
        "size", "mens", "womens", "men", "women", "kids", "unisex",
        "great", "good", "excellent", "nice", "perfect", "look", "looks",
        "free", "shipping", "fast", "ship", "item", "items", "brand",
    ]

    enum TermBand: Equatable { case empty, thin, good }

    struct Terms: Equatable {
        /// Title words no filled item specific already carries.
        var distinct: [String]
        /// Title words a filled item specific already carries. Padding, in effect.
        var redundant: [String]
        var count: Int
        var band: TermBand
    }

    static func tokenize(_ title: String) -> [String] {
        title.split(whereSeparator: { $0.isWhitespace }).compactMap { word in
            let bare = word.filter { $0.isLetter || $0.isNumber }.lowercased()
            return bare.isEmpty ? nil : bare
        }
    }

    /// Count what the title adds that the structured fields do not.
    ///
    /// A word already sitting in a filled item specific is REDUNDANT, not
    /// wrong: eBay indexes the aspect, so repeating it in the title buys
    /// nothing and costs characters. That is the whole mechanism by which
    /// pad-to-70 advice made listings worse.
    static func terms(_ title: String, aspects: [String: [String]] = [:]) -> Terms {
        var inAspects = Set<String>()
        for values in aspects.values {
            for value in values {
                for token in tokenize(value) { inAspects.insert(token) }
            }
        }

        var seen = Set<String>()
        var distinct: [String] = []
        var redundant: [String] = []
        for token in tokenize(title) {
            guard token.count >= 2, !nonSearchable.contains(token) else { continue }
            guard seen.insert(token).inserted else { continue }
            if inAspects.contains(token) { redundant.append(token) } else { distinct.append(token) }
        }

        let count = distinct.count
        let band: TermBand = count == 0 ? .empty : (count >= termGreenMin ? .good : .thin)
        return Terms(distinct: distinct, redundant: redundant, count: count, band: band)
    }

    // MARK: - Length

    /// There is no "good" length. The band says only whether the title is
    /// empty, within the cap, or at it -- a real eBay constraint rather than a
    /// target. A seller at 62 characters is not doing worse than one at 74.
    enum LengthBand: Equatable { case empty, within, full }

    struct Utilization: Equatable {
        var used: Int
        var max: Int
        var band: LengthBand
    }

    static func utilization(_ title: String, max: Int = maxLength) -> Utilization {
        let used = title.trimmingCharacters(in: .whitespacesAndNewlines).count
        let band: LengthBand = used == 0 ? .empty : (used >= max ? .full : .within)
        return Utilization(used: used, max: max, band: band)
    }

    /// True when the title leads with the brand (front-loading it lifts
    /// click-through). A missing brand is treated as satisfied -- there is
    /// nothing to front-load.
    static func isBrandFirst(_ title: String, brand: String?) -> Bool {
        let b = (brand ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !b.isEmpty else { return true }
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !t.isEmpty else { return false }
        return t == b || t.hasPrefix(b + " ")
    }

    // MARK: - Lint

    struct LintResult: Equatable {
        /// eBay policy breaches. These BLOCK a publish server-side.
        var policyViolations: [String]
        /// Quality warnings. Never blocking.
        var warnings: [String]

        var isEmpty: Bool { policyViolations.isEmpty && warnings.isEmpty }
    }

    /// Short all-caps tokens that are real vocabulary rather than shouting.
    static let allCapsAllowed: Set<String> = [
        "NWT", "NWOT", "NIB", "BNWT", "EUC", "VGUC", "GUC", "OOAK", "HTF",
        "XXS", "XS", "SM", "MD", "LG", "XL", "XXL", "XXXL", "OS", "OSFA", "REG",
        "USA", "US", "UK", "EU", "EUR", "JP",
        "DKNY", "BCBG", "APC", "YSL", "LV", "CK", "RRL", "MK", "UGG", "TNF",
        "AE", "AEO", "PJ", "GAP", "HM", "COS", "NB", "KSNY",
        "II", "III", "IV", "VI", "VII", "VIII", "IX",
    ]

    /// Comparing to another brand in a title is search manipulation under
    /// eBay's own policy, so these are violations rather than advice.
    private static let brandComparisonPatterns = [
        "\\bstyle\\s+of\\b",
        "\\bin\\s+the\\s+style\\s+of\\b",
        "\\bsimilar\\s+to\\b",
        "\\bcompared?\\s+to\\b",
        "\\binspired\\s+by\\b",
        "\\bfits?\\s+like\\s+(?!a\\b|an\\b|new\\b|glove\\b|dream\\b)",
    ]

    private static let fillerPatterns = [
        "l@@k",
        "l00k",
        "\\bwow\\b",
        "!{2,}",
        "\\bmust\\s*see\\b",
        "[★☆✩✪➤»«▶◀¡]",
    ]

    static func lint(_ rawTitle: String) -> LintResult {
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        var policyViolations: [String] = []
        var warnings: [String] = []
        guard !title.isEmpty else {
            return LintResult(policyViolations: policyViolations, warnings: warnings)
        }

        // One finding per family, like web: five variations of the same mistake
        // is one mistake, and listing them all buries the other checks.
        if let hit = firstMatch(in: title, patterns: brandComparisonPatterns) {
            policyViolations.append(
                "Remove the comparison phrase \"\(hit.trimmingCharacters(in: .whitespaces))\" — comparing to another brand in the title breaks eBay's search-manipulation policy."
            )
        }
        if let hit = firstMatch(in: title, patterns: fillerPatterns) {
            warnings.append(
                "Drop promotional filler (\"\(hit)\") — it wastes the 80-character search surface."
            )
        }

        var seen = Set<String>()
        var dupes: [String] = []
        for token in tokenize(title) where token.count >= 2 {
            if !seen.insert(token).inserted, !dupes.contains(token) { dupes.append(token) }
        }
        if !dupes.isEmpty {
            warnings.append(
                "Duplicate keyword\(dupes.count > 1 ? "s" : "") (\(dupes.joined(separator: ", "))) add no ranking benefit — replace with a new qualifier."
            )
        }

        var shouted: [String] = []
        for word in title.split(whereSeparator: { $0.isWhitespace }) {
            let bare = String(word).trimmingCharacters(
                in: CharacterSet.letters.inverted
            )
            guard bare.count >= 2,
                  bare.allSatisfy({ $0.isLetter && $0.isUppercase }),
                  !allCapsAllowed.contains(bare),
                  !shouted.contains(bare)
            else { continue }
            shouted.append(bare)
        }
        if !shouted.isEmpty {
            warnings.append(
                "Avoid ALL-CAPS word\(shouted.count > 1 ? "s" : "") (\(shouted.joined(separator: ", "))) — caps read as shouting and don't help search."
            )
        }

        return LintResult(policyViolations: policyViolations, warnings: warnings)
    }

    private static func firstMatch(in text: String, patterns: [String]) -> String? {
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(
                pattern: pattern, options: [.caseInsensitive]
            ) else { continue }
            let range = NSRange(text.startIndex..., in: text)
            guard let match = regex.firstMatch(in: text, range: range),
                  let hit = Range(match.range, in: text) else { continue }
            return String(text[hit])
        }
        return nil
    }

    // MARK: - Combined

    struct Report: Equatable {
        var utilization: Utilization
        var terms: Terms
        var brandFirst: Bool
        var lint: LintResult

        /// Too few distinct terms, or any lint finding. A padded 78-character
        /// title restating Brand and Size carries less than a 62-character one
        /// that does not, and the old character threshold called the padded one
        /// stronger.
        var isWeak: Bool {
            terms.count < termWeakBelow
                || !lint.policyViolations.isEmpty
                || !lint.warnings.isEmpty
        }
    }

    static func report(
        title: String, brand: String?, aspects: [String: [String]] = [:]
    ) -> Report {
        Report(
            utilization: utilization(title),
            terms: terms(title, aspects: aspects),
            brandFirst: isBrandFirst(title, brand: brand),
            lint: lint(title)
        )
    }
}
