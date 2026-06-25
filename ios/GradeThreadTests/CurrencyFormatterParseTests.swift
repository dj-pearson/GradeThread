import XCTest
@testable import GradeThread

/// US-1162: the money-input parser must accept the user's locale number format
/// (comma decimals + locale grouping), not just "12.34". These pin the
/// round-trip so a comma-decimal seller's price isn't silently dropped.
final class CurrencyFormatterParseTests: XCTestCase {

    func test_parse_commaDecimalLocale() {
        let f = CurrencyFormatter(locale: Locale(identifier: "de_DE"))
        XCTAssertEqual(f.parse("12,50"), 12.5)
        XCTAssertEqual(f.parse("1.234,56"), 1234.56) // dot is grouping here
        XCTAssertEqual(f.parse("0,99"), 0.99)
    }

    func test_parse_dotDecimalLocale() {
        let f = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertEqual(f.parse("12.50"), 12.5)
        XCTAssertEqual(f.parse("1,234.56"), 1234.56) // comma is grouping here
        XCTAssertNil(f.parse(""))
        XCTAssertNil(f.parse("   "))
    }

    func test_parse_rejectsMalformedNumerics() {
        // NumberFormatter.number(from:) partial-parses these; the guard must
        // reject them to nil rather than silently coerce to a leading value.
        let f = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertNil(f.parse("12.50.00"), "double decimal must reject, not parse 12.50")
        XCTAssertNil(f.parse("5-0"), "embedded minus must reject, not parse 5")
        XCTAssertNil(f.parse("--5"))
        XCTAssertNil(f.parse("1-2.3"))
        XCTAssertNil(f.parse("."))
        XCTAssertNil(f.parse("-"))
    }

    func test_parse_acceptsSingleLeadingMinus() {
        let f = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertEqual(f.parse("-12.50"), -12.5)
    }

    func test_formatRaw_parse_roundTrips() {
        for id in ["de_DE", "en_US", "fr_FR"] {
            let f = CurrencyFormatter(locale: Locale(identifier: id))
            let raw = f.formatRaw(19.99)
            XCTAssertEqual(f.parse(raw), 19.99, "round-trip failed for \(id)")
        }
    }
}
