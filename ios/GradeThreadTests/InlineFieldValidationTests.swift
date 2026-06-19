import XCTest
@testable import GradeThread

/// US-970: inline validation feedback for money/price/title fields.
final class InlineFieldValidationTests: XCTestCase {

    private let usd = CurrencyFormatter(locale: Locale(identifier: "en_US"))

    // MARK: - MoneyFieldValidation.positiveAmount

    func test_positiveAmount_parsesValidPositive() {
        XCTAssertEqual(MoneyFieldValidation.positiveAmount("12.50", formatter: usd), 12.50)
    }

    func test_positiveAmount_rejectsEmptyZeroAndGarbage() {
        XCTAssertNil(MoneyFieldValidation.positiveAmount("", formatter: usd))
        XCTAssertNil(MoneyFieldValidation.positiveAmount("   ", formatter: usd))
        XCTAssertNil(MoneyFieldValidation.positiveAmount("0", formatter: usd))
        XCTAssertNil(MoneyFieldValidation.positiveAmount("hello", formatter: usd))
    }

    // MARK: - requiredAmountHelp (Add-expense amount)

    func test_requiredAmountHelp_showsUntilValidPositive() {
        XCTAssertEqual(
            MoneyFieldValidation.requiredAmountHelp("", formatter: usd),
            MoneyFieldValidation.positiveAmountHelp
        )
        XCTAssertEqual(
            MoneyFieldValidation.requiredAmountHelp("0", formatter: usd),
            MoneyFieldValidation.positiveAmountHelp
        )
        XCTAssertNil(MoneyFieldValidation.requiredAmountHelp("9.99", formatter: usd))
    }

    func test_positiveAmountHelp_copy() {
        XCTAssertEqual(MoneyFieldValidation.positiveAmountHelp, "Enter an amount greater than 0")
    }

    // MARK: - optionalPriceHelp (canvas price — empty is allowed)

    func test_optionalPriceHelp_hiddenWhenEmpty() {
        XCTAssertNil(MoneyFieldValidation.optionalPriceHelp("", formatter: usd))
        XCTAssertNil(MoneyFieldValidation.optionalPriceHelp("   ", formatter: usd))
    }

    func test_optionalPriceHelp_hiddenForValidNumber() {
        XCTAssertNil(MoneyFieldValidation.optionalPriceHelp("25", formatter: usd))
        XCTAssertNil(MoneyFieldValidation.optionalPriceHelp("25.00", formatter: usd))
    }

    func test_optionalPriceHelp_shownForUnparseableInput() {
        XCTAssertEqual(
            MoneyFieldValidation.optionalPriceHelp("abc", formatter: usd),
            MoneyFieldValidation.invalidPriceHelp
        )
    }

    // MARK: - twoDecimalDisplay

    func test_twoDecimalDisplay_normalizesWireString() {
        XCTAssertEqual(MoneyFieldValidation.twoDecimalDisplay("25"), "25.00")
        XCTAssertEqual(MoneyFieldValidation.twoDecimalDisplay("25.5"), "25.50")
        XCTAssertEqual(MoneyFieldValidation.twoDecimalDisplay("25.99"), "25.99")
    }

    func test_twoDecimalDisplay_fallsBackOnUnparseable() {
        XCTAssertEqual(MoneyFieldValidation.twoDecimalDisplay("--"), "--")
    }

    // MARK: - TitleLimitFeedback

    func test_titleFeedback_normalWellBelowCap() {
        let f = TitleLimitFeedback(count: 10, limit: 80)
        XCTAssertEqual(f.level, .normal)
        XCTAssertEqual(f.counterText, "10/80")
        XCTAssertNil(f.atLimitNote)
    }

    func test_titleFeedback_approachingWithinWarnWindow() {
        // 80 - 75 = 5 remaining, inside the 10-char warn window.
        let f = TitleLimitFeedback(count: 75, limit: 80)
        XCTAssertEqual(f.level, .approaching)
        XCTAssertNil(f.atLimitNote)
    }

    func test_titleFeedback_atLimitWarnsAndNotes() {
        let f = TitleLimitFeedback(count: 80, limit: 80)
        XCTAssertEqual(f.level, .atLimit)
        XCTAssertEqual(f.atLimitNote, "Maximum 80 characters")
    }
}
