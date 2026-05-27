import XCTest
@testable import GradeThread

@MainActor
final class DetailsIntakeTests: XCTestCase {

    // MARK: - IntakeFormState

    func test_canSubmit_requiresTitle() {
        let form = IntakeFormState()
        XCTAssertFalse(form.canSubmit)

        form.title = "  "
        XCTAssertFalse(form.canSubmit, "whitespace title shouldn't count as filled")

        form.title = "Wool coat"
        XCTAssertTrue(form.canSubmit)
    }

    func test_resetForBatchAddAnother_preservesSourcingContext() {
        let form = IntakeFormState()
        // Fill everything.
        form.title = "Levi's 501"
        form.sku = "S-123"
        form.brand = "Levi's"
        form.size = "32x32"
        form.color = "indigo"
        form.material = "cotton"
        form.category = .clothing
        form.status = .cataloged
        form.notes = "Light wear"
        form.purchasePriceText = "12.50"
        form.sourceId = "src-abc"
        form.container = "B-12"
        form.sourcedBy = "Dan"
        form.purchaseDate = Date(timeIntervalSince1970: 1_700_000_000)

        form.resetForBatchAddAnother()

        // Item identity cleared:
        XCTAssertTrue(form.title.isEmpty)
        XCTAssertTrue(form.sku.isEmpty)
        XCTAssertTrue(form.brand.isEmpty)
        XCTAssertTrue(form.size.isEmpty)
        XCTAssertEqual(form.category, .clothing)
        XCTAssertEqual(form.status, .cataloged)
        XCTAssertTrue(form.notes.isEmpty)
        XCTAssertTrue(form.purchasePriceText.isEmpty)

        // Batch context retained:
        XCTAssertEqual(form.sourceId, "src-abc")
        XCTAssertEqual(form.container, "B-12")
        XCTAssertEqual(form.sourcedBy, "Dan")
        XCTAssertEqual(form.purchaseDate.timeIntervalSince1970, 1_700_000_000, accuracy: 0.001)
    }

    func test_resetAll_clearsEverythingIncludingSourcing() {
        let form = IntakeFormState()
        form.title = "X"
        form.sourceId = "src-1"
        form.container = "B-1"
        form.sourcedBy = "Dan"
        let before = form.purchaseDate

        form.resetAll()
        XCTAssertTrue(form.title.isEmpty)
        XCTAssertNil(form.sourceId)
        XCTAssertTrue(form.container.isEmpty)
        XCTAssertTrue(form.sourcedBy.isEmpty)
        XCTAssertGreaterThanOrEqual(form.purchaseDate, before)
    }

    // MARK: - CurrencyFormatter

    func test_currencyFormatter_parsesBareNumber() {
        let formatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertEqual(formatter.parse("12.50"), 12.50)
        XCTAssertEqual(formatter.parse("0"), 0)
    }

    func test_currencyFormatter_parsesWithGroupingSeparator() {
        let formatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertEqual(formatter.parse("1,234.56"), 1234.56)
    }

    func test_currencyFormatter_parsesEuropeLocale() {
        let formatter = CurrencyFormatter(locale: Locale(identifier: "de_DE"))
        // German locale uses '.' as grouping and ',' as decimal.
        XCTAssertEqual(formatter.parse("1.234,56"), 1234.56)
    }

    func test_currencyFormatter_parsesStrippedCurrencySymbol() {
        let formatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertEqual(formatter.parse("$12.50"), 12.50)
    }

    func test_currencyFormatter_emptyOrWhitespace_returnsNil() {
        let formatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertNil(formatter.parse(""))
        XCTAssertNil(formatter.parse("   "))
    }

    func test_currencyFormatter_garbage_returnsNil() {
        let formatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertNil(formatter.parse("hello"))
    }

    func test_currencyFormatter_displayUsesLocaleCurrency() {
        let formatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertEqual(formatter.formatDisplay(12.5), "$12.50")
    }

    func test_currencyFormatter_symbolReflectsLocale() {
        let usFormatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))
        XCTAssertEqual(usFormatter.symbol, "$")

        let euFormatter = CurrencyFormatter(locale: Locale(identifier: "fr_FR"))
        XCTAssertEqual(euFormatter.symbol, "€")
    }

    // MARK: - FlipdeskConstants wire fidelity

    func test_categoryRawValues_matchWireEnum() {
        // Sports cards is the trickiest — the web enum stores
        // sports_cards (snake_case) even though our Swift name is camel.
        XCTAssertEqual(FlipdeskCategory.sportsCards.rawValue, "sports_cards")
        XCTAssertEqual(FlipdeskCategory.clothing.rawValue, "clothing")
        XCTAssertEqual(FlipdeskCategory.other.rawValue, "other")
    }

    func test_sourceTypeRawValues_matchWireEnum() {
        XCTAssertEqual(FlipdeskSourceType.goodwillAuction.rawValue, "goodwill_auction")
        XCTAssertEqual(FlipdeskSourceType.estateSale.rawValue, "estate_sale")
        XCTAssertEqual(FlipdeskSourceType.retailArbitrage.rawValue, "retail_arbitrage")
    }

    func test_intakeStatusRawValues_matchItemStatusEnum() {
        XCTAssertEqual(IntakeStatus.cataloged.rawValue, "cataloged")
        XCTAssertEqual(IntakeStatus.sourced.rawValue, "sourced")
        XCTAssertEqual(IntakeStatus.keeping.rawValue, "keeping")
    }
}
