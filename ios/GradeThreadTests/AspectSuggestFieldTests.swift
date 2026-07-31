import SwiftUI
import XCTest
@testable import GradeThread

/// eBay ships recommended values for FREE_TEXT / SUGGESTED aspects (Brand,
/// Color, Material, Style), not just for the closed SELECTION_ONLY lists. The
/// web composer binds them to an `<input list=…>` datalist so the field
/// autocompletes; iOS threw the list away and rendered a bare TextField, so
/// sellers hand-typed "Black" in full on a field the API had already answered.
/// These pin the matching that backs the iOS suggestion chips.
final class AspectSuggestFieldTests: XCTestCase {
    private let colors = [
        "Black", "Blue", "Green", "Red", "White",
        "Cobalt Blue", "Blush", "Charcoal", "Navy Blue", "Olive",
    ]

    private func field(_ text: String, suggestions: [String]? = nil) -> AspectSuggestField {
        AspectSuggestField(
            placeholder: "Value",
            suggestions: suggestions ?? colors,
            text: .constant(text)
        )
    }

    func test_emptyQuery_showsTheHeadOfEbaysOwnOrdering() {
        // eBay returns values relevance-ordered, so an unfiltered prefix is a
        // sensible "popular values" list rather than an alphabetical dump.
        let matches = field("").matches
        XCTAssertEqual(matches.first, "Black")
        XCTAssertLessThanOrEqual(matches.count, 8, "must stay capped")
    }

    func test_prefixMatchesRankAboveSubstringMatches() {
        // "bl" → Black/Blue/Blush lead; "Cobalt Blue" and "Navy Blue" only
        // CONTAIN it, so they come after. This is the whole point: one or two
        // keystrokes should put the intended value first.
        let matches = field("bl").matches
        let prefixes = ["Black", "Blue", "Blush"]
        for value in prefixes {
            XCTAssertTrue(matches.contains(value), "\(value) should match 'bl'")
        }
        guard let cobalt = matches.firstIndex(of: "Cobalt Blue"),
              let black = matches.firstIndex(of: "Black")
        else { return XCTFail("expected both Black and Cobalt Blue in matches") }
        XCTAssertLessThan(black, cobalt, "prefix match must rank above substring")
    }

    func test_matchingIsCaseAndWhitespaceInsensitive() {
        XCTAssertTrue(field("  BLA  ").matches.contains("Black"))
        // Lowercase partial, NOT the whole value: a complete "black" is an
        // exact hit, which test_exactValueStopsSuggesting pins as empty. The
        // two assertions contradicted each other and this one lost.
        XCTAssertTrue(field("blac").matches.contains("Black"))
    }

    func test_exactValueStopsSuggesting() {
        // Once the field holds a real value, the chips are noise — and would
        // otherwise sit under every already-filled aspect.
        XCTAssertTrue(field("Black").matches.isEmpty)
        XCTAssertTrue(field("  black ").matches.isEmpty)
    }

    func test_noMatchesForAValueOutsideTheList() {
        // Free typing stays legal — the suggestions are an accelerator, not a
        // constraint, so an off-list value simply has nothing to offer.
        XCTAssertTrue(field("Heather Aubergine").matches.isEmpty)
    }

    func test_longListIsCappedSoOneAspectCannotSwallowTheForm() {
        // Color alone can carry 100+ values.
        let many = (0..<200).map { "Blue \($0)" }
        XCTAssertEqual(field("blue", suggestions: many).matches.count, 8)
    }

    func test_emptySuggestionListIsHandled() {
        // A category spec with no recommended values must not crash or offer
        // anything — that aspect falls back to the plain text row.
        XCTAssertTrue(field("any", suggestions: []).matches.isEmpty)
        XCTAssertTrue(field("", suggestions: []).matches.isEmpty)
    }
}
