import XCTest
@testable import GradeThread

/// US-1491: locale-safe numeric parsing across the money + measurement input
/// paths. The canvas save path previously parsed the eBay revise price with a
/// raw `Double(stripCommas)` while the DB payload used the locale-aware
/// CurrencyFormatter — so "24,99" in a comma-decimal locale saved 24.99 locally
/// but pushed 2499.0 to the live eBay offer (a 100× overprice). Measurement
/// bindings parsed with `Double(cleaned)` and silently dropped the fraction.
///
/// These pin the two failure modes the audit called out: the revise price and
/// the measurement value, both in de_DE.
final class LocaleSafeNumericParsingTests: XCTestCase {

    // MARK: eBay revise plan price (ItemCanvasView ebayPlan)

    /// The revise plan now derives newPrice/oldPrice from the SAME formatter the
    /// DB payload uses (currencyFormatter.parse). In de_DE, "24,99" must yield a
    /// 24.99 plan — not 2499.0.
    func test_revisePlanPrice_commaDecimalLocale_notInflated() {
        let f = CurrencyFormatter(locale: Locale(identifier: "de_DE"))
        // The exact value 'Use median' seeds and the seller edits.
        XCTAssertEqual(f.parse("24,99"), 24.99)
        // The old raw parse would have produced this 100× value — assert we don't.
        XCTAssertNotEqual(f.parse("24,99"), 2499.0)
    }

    /// 'Use median' seeds the field with formatRaw; the seed must parse back to
    /// the same value in every locale, otherwise the seed itself inflates.
    func test_medianSeed_roundTrips_acrossLocales() {
        for id in ["de_DE", "fr_FR", "en_US", "es_ES"] {
            let f = CurrencyFormatter(locale: Locale(identifier: id))
            let seed = f.formatRaw(24.99)
            XCTAssertEqual(f.parse(seed), 24.99, "median seed round-trip failed for \(id)")
        }
    }

    // MARK: Measurement field (MeasurementCatalog)

    /// "18,5" in de_DE must store 18.5 — the old Double("18,5") returned nil and
    /// dropped the row edit entirely.
    func test_measurementParse_commaDecimalLocale() {
        let de = Locale(identifier: "de_DE")
        XCTAssertEqual(MeasurementCatalog.parse("18,5", locale: de), 18.5)
        XCTAssertNil(MeasurementCatalog.parse("", locale: de))
        XCTAssertNil(MeasurementCatalog.parse("   ", locale: de))
    }

    func test_measurementParse_dotDecimalLocale() {
        let us = Locale(identifier: "en_US")
        XCTAssertEqual(MeasurementCatalog.parse("18.5", locale: us), 18.5)
    }

    /// The editable display seeds with the locale separator so the get→set
    /// round-trip is consistent (a "."-seed would re-parse as grouping in de_DE).
    func test_measurementEditableString_roundTrips() {
        for id in ["de_DE", "fr_FR", "en_US"] {
            let loc = Locale(identifier: id)
            let shown = MeasurementCatalog.editableString(18.5, locale: loc)
            XCTAssertEqual(MeasurementCatalog.parse(shown, locale: loc), 18.5,
                           "measurement round-trip failed for \(id)")
        }
    }

    /// Whole numbers show without a trailing fraction in every locale.
    func test_measurementEditableString_trimsWholeNumbers() {
        XCTAssertEqual(MeasurementCatalog.editableString(20, locale: Locale(identifier: "en_US")), "20")
        XCTAssertEqual(MeasurementCatalog.editableString(0, locale: Locale(identifier: "en_US")), "")
    }
}
