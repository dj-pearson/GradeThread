import Foundation

/// US-1891 / US-1995: backwards title sync - the SWIFT port.
///
/// Aspects sync both ways already, but `listings.listing_title` is a free-form
/// column nothing rebuilds, so correcting an item's Brand (or size/color/style)
/// after AI generation left the OLD value in the one field buyers search
/// hardest. This does deterministic, token-boundary substitution of old -> new
/// field values in a title (case-preserving, size-aware, multi-word brands),
/// re-trimmed to eBay's 80-char cap.
///
/// THERE ARE NOW THREE COPIES OF THIS LOGIC and that is deliberate: the web app,
/// the Deno edge service and the iOS app are separate build products that cannot
/// import each other.
///
///   src/lib/title-sync.ts                         (web)
///   services/edge-functions/src/lib/title-sync.ts (edge)
///   this file                                     (iOS)
///
/// A source diff cannot be the guard - the two JS copies already differ by ~80
/// lines, most of it legitimate (the web one inlines the trim because it cannot
/// import title-trim.ts). So the guard is BEHAVIOURAL: all three read the same
/// fixture, `src/test/fixtures/title-sync-cases.json`. Add a case there, never to
/// one suite. `TitleSyncFixtureTests` is the Swift half.
///
/// It lives in GradeThreadCore rather than the app target for the same reason
/// ConflictPolicy does: it is pure Foundation, so `swift test` builds and runs it
/// on Linux with no Mac, no simulator and no Xcode. That is the only way this
/// port gets executed on a Windows dev box.
public enum TitleSync {

    /// eBay's hard cap on a listing title.
    public static let ebayTitleMax = 80

    /// The item columns whose value can appear in a title. Order is part of the
    /// contract: ``changesFromItemDiff`` emits changes in this order, and
    /// ``syncTitle`` applies them in the order given (a later change sees the
    /// result of an earlier one).
    ///
    /// `department` is here for parity with the JS copies even though iOS has no
    /// `department` COLUMN - it is a canonical eBay aspect on
    /// `inventory_items.attributes` and travels through `writeAttributes`. Keeping
    /// it in the list means the fixture's `changesFromItemDiff` cases pass
    /// unchanged and a future iOS caller that does have a department can pass one.
    public static let syncableTitleFields = ["brand", "size", "color", "style", "department"]

    // MARK: - Field changes

    /// One old -> new value for a syncable field. `field` is informational; only
    /// `from`/`to` drive the substitution.
    public struct FieldChange: Equatable, Sendable {
        public let field: String?
        public let from: String?
        public let to: String?

        public init(field: String? = nil, from: String?, to: String?) {
            self.field = field
            self.from = from
            self.to = to
        }
    }

    /// Build the change list from before/after field maps, keeping only the
    /// syncable fields that actually changed. A nil/blank value on either side is
    /// skipped: a fill (blank -> value) has nothing to substitute FOR, and a clear
    /// (value -> blank) would delete words out of the title.
    public static func changesFromItemDiff(
        before: [String: String?],
        after: [String: String?]
    ) -> [FieldChange] {
        var changes: [FieldChange] = []
        for field in syncableTitleFields {
            guard let from = (before[field] ?? nil), let to = (after[field] ?? nil) else { continue }
            let fromTrimmed = from.trimmingCharacters(in: .whitespacesAndNewlines)
            let toTrimmed = to.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !fromTrimmed.isEmpty, !toTrimmed.isEmpty, fromTrimmed != toTrimmed else { continue }
            changes.append(FieldChange(field: field, from: from, to: to))
        }
        return changes
    }

    // MARK: - Substitution

    /// Replace whole-token occurrences of `from` with `to` in `title`, matched
    /// case-insensitively at non-alphanumeric boundaries. Handles multi-word
    /// values ("The North Face") and - because the replaced unit is the bounded
    /// token itself - every size shape uniformly: "Size L", "Sz L" and a bare "L"
    /// all have the "L" token replaced, while "XL" is left alone. Returns the
    /// title unchanged when `from` is absent, or the change is empty/identical.
    ///
    /// IDEMPOTENT: applying the same change twice equals applying it once.
    public static func applyTitleSubstitution(
        _ title: String?,
        from: String?,
        to: String?
    ) -> String {
        let src = title ?? ""
        let oldVal = (from ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let newVal = (to ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !oldVal.isEmpty, !newVal.isEmpty else { return src }
        guard oldVal.lowercased() != newVal.lowercased() else { return src }
        guard let oldRegex = tokenBoundedRegex(oldVal) else { return src }

        // This has to be IDEMPOTENT, and a bare replace is not.
        //
        // When the new value CONTAINS the old one - "L" -> "L/XL", "North Face"
        // -> "The North Face", "Blue" -> "Blue Navy", "501" -> "501 Original" - a
        // second pass matches the old value sitting inside the replacement it just
        // wrote and expands again: "L/XL/XL", "The The North Face". Those are not
        // exotic inputs; widening a size and qualifying a brand are everyday
        // seller corrections.
        //
        // It matters because idempotence is the ONLY thing standing between two
        // surfaces that both sync and a corrupted title. `changes` is computed
        // from a captured before-map, so a retried write or a stale local mirror
        // replays {from: old, to: new} against a title that already holds the new
        // value. "Pick one owner per surface" is the design, but it is a
        // convention, and a convention is not a guard.
        //
        // So in the containing case, spans that ALREADY read as the new value are
        // protected and only occurrences outside them are replaced.
        var guarded: [Range<String.Index>] = []
        if !ranges(of: oldRegex, in: newVal).isEmpty, let newRegex = tokenBoundedRegex(newVal) {
            guarded = ranges(of: newRegex, in: src)
        }

        var out = ""
        var cursor = src.startIndex
        for match in ranges(of: oldRegex, in: src) {
            let alreadyNew = guarded.contains {
                $0.lowerBound <= match.lowerBound && match.upperBound <= $0.upperBound
            }
            if alreadyNew { continue }
            out.append(contentsOf: src[cursor..<match.lowerBound])
            out.append(transferCase(matched: String(src[match]), replacement: newVal))
            cursor = match.upperBound
        }
        out.append(contentsOf: src[cursor...])
        return out
    }

    /// Apply a batch of changes to a title and re-trim to the limit. Order is
    /// preserved (later changes see the results of earlier ones). Empty/no-op
    /// changes are skipped. The result is whitespace-normalized and word-boundary
    /// trimmed, so a longer new brand cannot overflow the cap.
    public static func syncTitle(
        _ title: String?,
        changes: [FieldChange],
        limit: Int = ebayTitleMax
    ) -> String {
        var out = title ?? ""
        for change in changes {
            out = applyTitleSubstitution(out, from: change.from, to: change.to)
        }
        return trimTitleToLimit(out, limit: limit)
    }

    /// True when syncing the changes would actually alter the title (after trim).
    /// Lets a caller skip a write when nothing moved.
    public static func titleNeedsSync(
        _ title: String?,
        changes: [FieldChange],
        limit: Int = ebayTitleMax
    ) -> Bool {
        syncTitle(title, changes: changes, limit: limit) != trimTitleToLimit(title ?? "", limit: limit)
    }

    // MARK: - Trim (mirror of services/edge-functions/src/lib/title-trim.ts)

    /// Collapse whitespace runs to single spaces and trim the ends. eBay ignores
    /// extra whitespace but it wastes characters against the cap.
    public static func normalizeTitleWhitespace(_ title: String) -> String {
        title
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Trim to `limit` on word boundaries, keeping the leading (highest-value)
    /// keywords and never cutting a word in half, then strip any separator left
    /// dangling at the new end.
    public static func trimTitleToLimit(_ title: String, limit: Int = ebayTitleMax) -> String {
        let normalized = normalizeTitleWhitespace(title)
        // Length is measured in UTF-16 units, not Characters, because the two JS
        // copies measure `String.length` and this file has to agree with them on
        // the fixture. They differ only for astral-plane text in a title, which no
        // marketplace title carries in practice.
        if normalized.utf16.count <= limit { return normalized }

        var out = ""
        for word in normalized.split(separator: " ") {
            let candidate = out.isEmpty ? String(word) : out + " " + String(word)
            if candidate.utf16.count > limit { break }
            out = candidate
        }

        // No whole word fit (the first token alone exceeds the limit) -> hard-cut
        // it. The JS slices by UTF-16 offset, which can split a surrogate pair;
        // this accumulates whole Characters instead, so the only divergence is
        // that a lone >80-char word containing an emoji keeps one fewer character.
        // Emitting half a surrogate is not worth matching.
        if out.isEmpty {
            return stripTrailingJunk(hardCut(normalized, utf16Limit: limit))
        }
        return stripTrailingJunk(out)
    }

    // MARK: - Internals

    /// Characters a trimmed title must never END on: dangling separators and open
    /// punctuation left behind when the following word is dropped. The en/em
    /// dashes are written as escapes so this source file stays ASCII.
    private static let trailingJunk: CharacterSet = CharacterSet(
        charactersIn: "-\u{2013}\u{2014}_/|,;:.&+([{<\"'`"
    ).union(.whitespacesAndNewlines)

    private static func stripTrailingJunk(_ value: String) -> String {
        var out = value[...]
        while let last = out.last, last.unicodeScalars.allSatisfy({ trailingJunk.contains($0) }) {
            out = out.dropLast()
        }
        return String(out)
    }

    private static func hardCut(_ value: String, utf16Limit: Int) -> String {
        var out = ""
        for character in value {
            if out.utf16.count + String(character).utf16.count > utf16Limit { break }
            out.append(character)
        }
        return out
    }

    /// Boundaries: not preceded/followed by a letter or number. Lets "L" match as
    /// a whole token but never inside "XL" or "Long".
    private static func tokenBoundedRegex(_ value: String) -> NSRegularExpression? {
        let escaped = NSRegularExpression.escapedPattern(for: value)
        return try? NSRegularExpression(
            pattern: "(?<![\\p{L}\\p{N}])\(escaped)(?![\\p{L}\\p{N}])",
            options: [.caseInsensitive]
        )
    }

    private static func ranges(
        of regex: NSRegularExpression,
        in value: String
    ) -> [Range<String.Index>] {
        let full = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.matches(in: value, options: [], range: full)
            .compactMap { Range($0.range, in: value) }
    }

    /// Carry the CASE STYLE of the matched title token onto the replacement so a
    /// swap reads naturally: ALL-CAPS stays caps, all-lower stays lower, anything
    /// else (including a token with no letters at all, like a style code) uses the
    /// new value's own canonical casing.
    private static func transferCase(matched: String, replacement: String) -> String {
        let letters = String(matched.filter { $0.isLetter })
        guard !letters.isEmpty else { return replacement }
        if letters == letters.uppercased() { return replacement.uppercased() }
        if letters == letters.lowercased() { return replacement.lowercased() }
        return replacement
    }
}
