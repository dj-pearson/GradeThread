import XCTest
@testable import GradeThread

/// The rules behind recording a sale on iOS. Every one of these guards a number
/// that outlives the moment it is typed: a wrong total here is not a wrong
/// screen, it is a wrong month.
final class RecordSaleTests: XCTestCase {

    /// The app parses money through CurrencyFormatter, which is locale aware.
    /// These tests use the same entry point rather than Double(_:), because
    /// that is what a de_DE seller's "19,99" goes through.
    private let formatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))
    private var parse: (String) -> Double? { formatter.parse }

    // MARK: - The total

    func test_netProfit_isEverythingInMinusEverythingOut() {
        var form = RecordSaleForm()
        form.salePrice = "100"
        form.shippingCollected = "10"
        form.platformFees = "13"
        form.paymentProcessingFees = "3"
        form.shippingCost = "8"
        form.tax = "2"
        form.otherCosts = "1"
        // 110 in, 27 out, 20 paid for it.
        XCTAssertEqual(form.netProfit(purchasePrice: 20, parse: parse), 63, accuracy: 0.001)
    }

    func test_netProfit_treatsBlankLinesAsZero() {
        var form = RecordSaleForm()
        form.salePrice = "50"
        XCTAssertEqual(form.netProfit(purchasePrice: 0, parse: parse), 50, accuracy: 0.001)
    }

    // A sale below cost is a real thing that happens, and the number has to say
    // so rather than clamping at zero.
    func test_netProfit_canBeNegative() {
        var form = RecordSaleForm()
        form.salePrice = "10"
        form.platformFees = "2"
        XCTAssertEqual(form.netProfit(purchasePrice: 40, parse: parse), -32, accuracy: 0.001)
    }

    // MARK: - What stops the save

    func test_validation_rejectsAMissingOrZeroPrice() {
        var form = RecordSaleForm()
        XCTAssertNotNil(form.validationError(parse: parse))
        form.salePrice = "0"
        XCTAssertNotNil(form.validationError(parse: parse))
        form.salePrice = "not a price"
        XCTAssertNotNil(form.validationError(parse: parse))
        form.salePrice = "0.01"
        XCTAssertNil(form.validationError(parse: parse))
    }

    // A negative fee INFLATES net profit instead of reducing it, and nothing
    // downstream questions it.
    func test_validation_rejectsNegativeFees() {
        var form = RecordSaleForm()
        form.salePrice = "100"
        form.platformFees = "-13"
        XCTAssertEqual(form.validationError(parse: parse), "Fees and costs can't be negative.")
        form.platformFees = "13"
        XCTAssertNil(form.validationError(parse: parse))
        form.otherCosts = "-1"
        XCTAssertNotNil(form.validationError(parse: parse))
    }

    // MARK: - Which statuses a sale owns

    func test_saleOwnedStatuses_matchTheWebSet() {
        XCTAssertEqual(SaleOwnedStatus.all, ["sold", "shipped", "completed", "returned"])
        // Archived is NOT here. Shelving an item is a decision the seller makes
        // by hand and no money moves, so the picker must keep offering it.
        XCTAssertFalse(SaleOwnedStatus.owns("archived"))
        XCTAssertTrue(SaleOwnedStatus.owns("SOLD"))
        XCTAssertTrue(SaleOwnedStatus.owns("  shipped "))
        XCTAssertFalse(SaleOwnedStatus.owns("listed"))
    }

    func test_selectable_dropsSaleStatusesButKeepsTheCurrentOne() {
        let all = InventoryStage.allKnownStatuses
        let forListed = SaleOwnedStatus.selectable(from: all, current: "listed")
        XCTAssertFalse(forListed.contains("sold"))
        XCTAssertFalse(forListed.contains("shipped"))
        XCTAssertFalse(forListed.contains("completed"))
        XCTAssertFalse(forListed.contains("returned"))
        XCTAssertTrue(forListed.contains("listed"))
        XCTAssertTrue(forListed.contains("archived"))

        // An already-sold item keeps its own status listed, or its picker would
        // render showing something the item is not.
        let forSold = SaleOwnedStatus.selectable(from: all, current: "sold")
        XCTAssertTrue(forSold.contains("sold"))
        XCTAssertFalse(forSold.contains("shipped"))
    }

    // MARK: - The values the row is written with

    func test_saleValues_parseOnceAndTrimTheBuyer() {
        var form = RecordSaleForm()
        form.salePrice = "1,234.50"
        form.platformFees = "12"
        form.buyerUsername = "  thrift_hunter  "
        let values = SaleValues(form: form, parse: parse)
        XCTAssertEqual(values.salePrice, 1234.50, accuracy: 0.001)
        XCTAssertEqual(values.platformFees, 12, accuracy: 0.001)
        XCTAssertEqual(values.shippingCost, 0, accuracy: 0.001)
        XCTAssertEqual(values.buyerUsername, "thrift_hunter")
    }

    // A blank buyer must be null on the row, not an empty string that later
    // reads as "there is a buyer named nothing".
    func test_saleValues_blankBuyerIsNil() {
        var form = RecordSaleForm()
        form.salePrice = "10"
        form.buyerUsername = "   "
        XCTAssertNil(SaleValues(form: form, parse: parse).buyerUsername)
    }

    // MARK: - Forward-only advance

    // The recorder only writes "sold" when the item is behind it. An item that
    // already shipped must not be dragged back a stage by recording the sale
    // late -- the same rule as the web advanceItemStatus.
    func test_soldOnlyAdvancesFromEarlierStages() {
        XCTAssertLessThan(ItemWorkflow.rank("listed"), ItemWorkflow.rank("sold"))
        XCTAssertLessThan(ItemWorkflow.rank("drafted"), ItemWorkflow.rank("sold"))
        XCTAssertGreaterThan(ItemWorkflow.rank("shipped"), ItemWorkflow.rank("sold"))
        XCTAssertGreaterThan(ItemWorkflow.rank("completed"), ItemWorkflow.rank("sold"))
    }
}
