import XCTest
@testable import GradeThread

/// US-789: a composer price that fails to parse — or parses to <= 0 — must
/// throw rather than seed a $0 (or garbage) listing draft. Exercises the
/// extracted, network-free validator with pinned locales so the comma-decimal
/// case is deterministic.
final class ListingDraftPriceTests: XCTestCase {

    private let usFormatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))

    func test_validPrice_parses() throws {
        let price = try ListingDraftService.validatedListingPrice("24.99", formatter: usFormatter)
        XCTAssertEqual(price, 24.99, accuracy: 0.0001)
    }

    func test_currencySymbolStripped() throws {
        let price = try ListingDraftService.validatedListingPrice("$24.99", formatter: usFormatter)
        XCTAssertEqual(price, 24.99, accuracy: 0.0001)
    }

    func test_groupingSeparatorStripped_enUS() throws {
        // en_US: comma is the grouping separator → "1,234.56" is 1234.56.
        let price = try ListingDraftService.validatedListingPrice("1,234.56", formatter: usFormatter)
        XCTAssertEqual(price, 1234.56, accuracy: 0.0001)
    }

    func test_commaDecimal_parsesInEuropeanLocale() throws {
        // de_DE: comma is the decimal separator → "24,99" is 24.99 (not 2499).
        let de = CurrencyFormatter(locale: Locale(identifier: "de_DE"))
        let price = try ListingDraftService.validatedListingPrice("24,99", formatter: de)
        XCTAssertEqual(price, 24.99, accuracy: 0.0001)
    }

    func test_emptyString_throws() {
        XCTAssertThrowsError(try ListingDraftService.validatedListingPrice("", formatter: usFormatter)) {
            XCTAssertTrue($0 is ListingDraftService.ListingDraftError)
        }
    }

    func test_whitespaceOnly_throws() {
        XCTAssertThrowsError(try ListingDraftService.validatedListingPrice("   ", formatter: usFormatter))
    }

    func test_garbageString_throws() {
        XCTAssertThrowsError(try ListingDraftService.validatedListingPrice("abc", formatter: usFormatter))
    }

    func test_zero_throws() {
        XCTAssertThrowsError(try ListingDraftService.validatedListingPrice("0", formatter: usFormatter))
    }

    func test_negative_throws() {
        XCTAssertThrowsError(try ListingDraftService.validatedListingPrice("-5", formatter: usFormatter))
    }

    func test_errorMessageIsUserFacing() {
        do {
            _ = try ListingDraftService.validatedListingPrice("", formatter: usFormatter)
            XCTFail("expected throw")
        } catch let error as ListingDraftService.ListingDraftError {
            XCTAssertEqual(
                error.errorDescription,
                "Enter a valid price greater than $0 before publishing."
            )
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
    }
}
