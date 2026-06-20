import XCTest
@testable import GradeThread

@MainActor
final class DetailsIntakeTests: XCTestCase {

    // MARK: - IntakeDraftStore (US-646)

    func test_intakeDraft_roundTripsFormFields() {
        IntakeDraftStore.clear()
        defer { IntakeDraftStore.clear() }

        let form = IntakeFormState()
        form.title = "Wool coat"
        form.brand = "Pendleton"
        form.size = "L"
        form.category = .clothing
        form.status = .sourced
        form.notes = "small moth hole"
        IntakeDraftStore.save(form)

        let loaded = IntakeDraftStore.load()
        XCTAssertNotNil(loaded)

        let restored = IntakeFormState()
        IntakeDraftStore.apply(loaded!, to: restored)
        XCTAssertEqual(restored.title, "Wool coat")
        XCTAssertEqual(restored.brand, "Pendleton")
        XCTAssertEqual(restored.size, "L")
        XCTAssertEqual(restored.status, .sourced)
        XCTAssertEqual(restored.notes, "small moth hole")
    }

    func test_intakeDraft_emptyFormSavesNothing() {
        IntakeDraftStore.clear()
        defer { IntakeDraftStore.clear() }
        IntakeDraftStore.save(IntakeFormState())  // all defaults → no content
        XCTAssertNil(IntakeDraftStore.load())
    }

    func test_intakeDraft_clearRemovesDraft() {
        let form = IntakeFormState()
        form.title = "Temp"
        IntakeDraftStore.save(form)
        IntakeDraftStore.clear()
        XCTAssertNil(IntakeDraftStore.load())
    }

    // MARK: - IntakeFormState

    func test_canSubmit_requiresTitle() {
        let form = IntakeFormState()
        XCTAssertFalse(form.canSubmit)

        form.title = "  "
        XCTAssertFalse(form.canSubmit, "whitespace title shouldn't count as filled")

        form.title = "Wool coat"
        XCTAssertTrue(form.canSubmit)
    }

    func test_isTitleMissing_tracksTitle() {
        let form = IntakeFormState()
        // Empty title → the required helper should show.
        XCTAssertTrue(form.isTitleMissing)

        form.title = "   "
        XCTAssertTrue(form.isTitleMissing, "whitespace-only title still counts as missing")

        form.title = "Wool coat"
        XCTAssertFalse(form.isTitleMissing, "helper hides once a title is entered")

        // It's exactly the inverse of the Save gate.
        XCTAssertEqual(form.isTitleMissing, !form.canSubmit)
    }

    func test_titleRequiredHelp_copy() {
        XCTAssertEqual(IntakeFormState.titleRequiredHelp, "A title is required to save")
    }

    // MARK: - US-754 inline validation

    func test_titleValidationMessage_mirrorsMissingState() {
        let form = IntakeFormState()
        // Empty → the same copy the on-screen FieldError + VoiceOver use.
        XCTAssertEqual(form.titleValidationMessage, IntakeFormState.titleRequiredHelp)
        form.title = "Wool coat"
        XCTAssertNil(form.titleValidationMessage, "message clears once a title is entered")
        // Single source of truth: it tracks isTitleMissing exactly.
        form.title = "   "
        XCTAssertEqual(form.titleValidationMessage != nil, form.isTitleMissing)
    }

    func test_clampTitleToLimit_truncatesOverflowOnly() {
        let form = IntakeFormState()
        form.title = String(repeating: "a", count: IntakeFormState.titleLimit + 25)
        form.clampTitleToLimit()
        XCTAssertEqual(form.title.count, IntakeFormState.titleLimit)

        // A normal-length title is left untouched (no fighting normal typing).
        form.title = "Vintage Levi's 501"
        form.clampTitleToLimit()
        XCTAssertEqual(form.title, "Vintage Levi's 501")
    }

    func test_titleFeedback_levelsTrackLength() {
        let form = IntakeFormState()
        form.title = "short"
        XCTAssertEqual(form.titleFeedback.level, .normal)
        XCTAssertNil(form.titleFeedback.atLimitNote)

        form.title = String(repeating: "a", count: IntakeFormState.titleLimit)
        XCTAssertEqual(form.titleFeedback.level, .atLimit)
        XCTAssertEqual(
            form.titleFeedback.atLimitNote,
            "Maximum \(IntakeFormState.titleLimit) characters")
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
