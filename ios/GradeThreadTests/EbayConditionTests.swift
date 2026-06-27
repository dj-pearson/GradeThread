import XCTest
@testable import GradeThread

final class EbayConditionTests: XCTestCase {

    func test_resolve_knownValues() {
        XCTAssertEqual(EbayCondition.resolve("NEW"), .new)
        XCTAssertEqual(EbayCondition.resolve("LIKE_NEW"), .likeNew)
        XCTAssertEqual(EbayCondition.resolve("USED_EXCELLENT"), .usedExcellent)
        XCTAssertEqual(EbayCondition.resolve("FOR_PARTS_OR_NOT_WORKING"), .forParts)
    }

    func test_resolve_nilOrUnknown_defaultsToUsedExcellent() {
        XCTAssertEqual(EbayCondition.resolve(nil), .usedExcellent)
        XCTAssertEqual(EbayCondition.resolve(""), .usedExcellent)
        XCTAssertEqual(EbayCondition.resolve("SOMETHING_NEW"), .usedExcellent)
    }

    func test_rawValues_matchEbayApiStrings() {
        XCTAssertEqual(EbayCondition.likeNew.rawValue, "LIKE_NEW")
        XCTAssertEqual(EbayCondition.usedVeryGood.rawValue, "USED_VERY_GOOD")
        XCTAssertEqual(EbayCondition.usedAcceptable.rawValue, "USED_ACCEPTABLE")
    }

    func test_allCases_haveDistinctRawValuesAndLabels() {
        let raws = Set(EbayCondition.allCases.map(\.rawValue))
        XCTAssertEqual(raws.count, EbayCondition.allCases.count, "raw values must be unique")
        let labels = Set(EbayCondition.allCases.map(\.label))
        XCTAssertEqual(labels.count, EbayCondition.allCases.count, "labels must be unique")
    }

    func test_resolve_roundTripsEveryCase() {
        for condition in EbayCondition.allCases {
            XCTAssertEqual(EbayCondition.resolve(condition.rawValue), condition)
        }
    }

    // MARK: - displayLabel (US-1268: no invented fallback)

    func test_displayLabel_recognizedValueMapsToLabel() {
        XCTAssertEqual(EbayCondition.displayLabel(for: "USED_GOOD"), EbayCondition.usedGood.label)
        XCTAssertEqual(EbayCondition.displayLabel(for: "NEW"), EbayCondition.new.label)
    }

    func test_displayLabel_unrecognizedValueShownVerbatim_notExcellent() {
        // Must NOT coerce to "Pre-owned – Excellent" the way resolve() does.
        XCTAssertEqual(EbayCondition.displayLabel(for: "USED"), "USED")
        XCTAssertEqual(EbayCondition.displayLabel(for: "SOMETHING_NEW"), "SOMETHING_NEW")
    }

    func test_displayLabel_blankOrNilReturnsNil() {
        XCTAssertNil(EbayCondition.displayLabel(for: nil))
        XCTAssertNil(EbayCondition.displayLabel(for: ""))
        XCTAssertNil(EbayCondition.displayLabel(for: "   "))
    }
}
