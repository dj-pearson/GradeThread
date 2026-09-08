import XCTest
@testable import GradeThread

/// US-3014 — the mileage log and the receipt scan.
///
/// Everything here is the PURE half: the parsing, the validation, the date rule
/// and the decoding. What is deliberately not here is the store, which needs a
/// live Supabase client, and the views, which need a simulator — both of those
/// are what iOS CI on a macOS runner is for.
@MainActor
final class MileageTests: XCTestCase {

    // MARK: - Miles

    func test_parsesWholeMiles() {
        var d = TripDraft.today()
        d.milesText = "12"
        XCTAssertEqual(d.tenthsOfMile, 120)
        XCTAssertEqual(d.miles ?? 0, 12.0, accuracy: 0.0001)
    }

    func test_parsesOneDecimalPlace() {
        var d = TripDraft.today()
        d.milesText = "12.3"
        XCTAssertEqual(d.tenthsOfMile, 123)
    }

    func test_truncatesASecondDecimalRatherThanRounding() {
        // Rounding 12.35 up to 12.4 invents a distance the seller did not
        // drive, and the column is numeric(8,1) so it cannot hold it anyway.
        var d = TripDraft.today()
        d.milesText = "12.35"
        XCTAssertEqual(d.tenthsOfMile, 123)
    }

    func test_keepsAHalfTypedNumberOnScreen() {
        // "12." is what the field holds mid-keystroke. It has to parse rather
        // than blank the value under the cursor.
        var d = TripDraft.today()
        d.milesText = "12."
        XCTAssertEqual(d.tenthsOfMile, 120)
    }

    func test_acceptsALeadingDecimalPoint() {
        var d = TripDraft.today()
        d.milesText = ".5"
        XCTAssertEqual(d.tenthsOfMile, 5)
    }

    func test_stripsAThousandsSeparator() {
        var d = TripDraft.today()
        d.milesText = "1,200"
        XCTAssertEqual(d.tenthsOfMile, 12000)
    }

    func test_refusesTwoDecimalPointsRatherThanCoercingThem() {
        // "1.2.3" quietly becoming 1.2 puts miles in the log the seller never
        // typed, which is worse than the field going invalid.
        var d = TripDraft.today()
        d.milesText = "1.2.3"
        XCTAssertNil(d.tenthsOfMile)
    }

    func test_refusesLettersAndAnEmptyField() {
        var d = TripDraft.today()
        for text in ["", "  ", "abc", "12a", "-4"] {
            d.milesText = text
            XCTAssertNil(d.tenthsOfMile, "\(text) should not parse")
        }
    }

    // MARK: - Validation

    func test_namesTheReasonItCannotBeSaved() {
        var d = TripDraft.today()
        XCTAssertEqual(d.invalidReason, .noMiles)

        d.milesText = "0"
        XCTAssertEqual(d.invalidReason, .zeroMiles)

        d.milesText = "100000"
        XCTAssertEqual(d.invalidReason, .tooManyMiles)

        d.milesText = "12"
        d.purpose = "   "
        XCTAssertEqual(d.invalidReason, .noPurpose)

        d.purpose = "sourcing"
        XCTAssertNil(d.invalidReason)
        XCTAssertTrue(d.isValid)
    }

    func test_rejectsWhatTheServerWouldReject() {
        // The server's CHECK is `miles > 0 AND miles < 100000`. Rejecting on
        // this side keeps the message in the seller's words AND keeps a row
        // Postgres will never accept out of the offline queue, where it would
        // retry on every reconnect for ever.
        var d = TripDraft.today()
        d.milesText = "99999.9"
        XCTAssertTrue(d.isValid)
        d.milesText = "100000"
        XCTAssertFalse(d.isValid)
    }

    func test_everyInvalidReasonHasASentence() {
        let all: [TripDraft.Invalid] = [.noMiles, .zeroMiles, .tooManyMiles, .noPurpose]
        for reason in all {
            XCTAssertFalse(reason.message.isEmpty)
        }
    }

    // MARK: - Purposes

    func test_labelsAWirePurposeAndAdmitsWhenItCannot() {
        XCTAssertEqual(TripDraft.label(forWire: "post_office"), "Post office")
        // Nil, not the raw wire value: returning "post_office" from here would
        // put an underscore on screen the day an id changes.
        XCTAssertNil(TripDraft.label(forWire: "picking up a consignment"))
        // The display helper is what falls back, and it falls back to what the
        // seller actually typed.
        XCTAssertEqual(
            TripDraft.displayPurpose("picking up a consignment"),
            "picking up a consignment"
        )
    }

    func test_defaultsToSourcing() {
        XCTAssertEqual(TripDraft.today().purpose, "sourcing")
    }

    // MARK: - The date rule (AC2)

    func test_aTripDateSurvivesTheRoundTrip() {
        // US-2339 is this exact value walking back a day per edit cycle,
        // because the parse and the format disagreed about the zone. One named
        // place, one zone.
        let iso = "2026-01-01"
        let parsed = MoneyDate.parse(iso)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(MoneyDate.iso(parsed ?? .distantPast), iso)
    }

    func test_theRoundTripIsStableOverManyEdits() {
        // The bug does not show on one cycle. It shows on the fifth.
        var date = MoneyDate.parse("2026-03-01") ?? .distantPast
        for _ in 0..<10 {
            date = MoneyDate.parse(MoneyDate.iso(date)) ?? .distantPast
        }
        XCTAssertEqual(MoneyDate.iso(date), "2026-03-01")
    }

    func test_aDateOnlyValueKeepsItsYearAtTheBoundary() {
        // 1 January is the one day of the year the zone costs money: a trip
        // that slips to 31 December lands in the wrong tax year.
        let jan1 = MoneyDate.parse("2027-01-01") ?? .distantPast
        XCTAssertEqual(MoneyDate.year(of: jan1), 2027)
        let dec31 = MoneyDate.parse("2026-12-31") ?? .distantPast
        XCTAssertEqual(MoneyDate.year(of: dec31), 2026)
    }

    func test_refusesAnUnreadableDateRatherThanSubstitutingToday() {
        // A silent fallback to today would put a trip in the wrong year and
        // look like it worked.
        XCTAssertNil(MoneyDate.parse("not a date"))
        XCTAssertNil(MoneyDate.parse("01/02/2026"))
    }

    func test_todayIsAnchoredTheWayStoredDatesAre() {
        let anchored = MoneyDate.today()
        XCTAssertEqual(MoneyDate.startOfDay(anchored), anchored)
    }

    // MARK: - Totals

    func test_totalsRoundPerTripNotOnTheSum() {
        // Per trip, because that is what the server summary and the packet do.
        // Summing full precision and rounding once at the end gives a different
        // figure, and two answers for the same drives is what the books epic
        // exists to prevent.
        let trips = [
            trip(miles: 0.05, on: "2026-02-01"),
            trip(miles: 0.05, on: "2026-02-02"),
        ]
        // Each rounds to 0.1, so the total is 0.2 — not the 0.1 a
        // sum-then-round would give.
        XCTAssertEqual(MileageTotals.miles(in: trips, year: 2026), 0.2, accuracy: 0.0001)
    }

    func test_totalsCountOnlyTheYearAsked() {
        let trips = [
            trip(miles: 10, on: "2026-06-01"),
            trip(miles: 99, on: "2025-06-01"),
        ]
        XCTAssertEqual(MileageTotals.miles(in: trips, year: 2026), 10, accuracy: 0.0001)
        XCTAssertEqual(MileageTotals.tripCount(in: trips, year: 2026), 1)
    }

    private func trip(miles: Double, on iso: String) -> LocalMileageTrip {
        LocalMileageTrip(
            id: UUID().uuidString.lowercased(),
            tripDate: MoneyDate.parse(iso) ?? .distantPast,
            miles: miles,
            purpose: "sourcing"
        )
    }
}
