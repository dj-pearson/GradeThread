import GradeThreadCore
import XCTest
@testable import GradeThread

/// US-676: consignment payout rollup, consignor draft validation, and SKU label
/// generation.
@MainActor
final class ConsignmentTests: XCTestCase {

    private func consignor(_ id: String, _ name: String, split: Double = 50) -> Consignor {
        Consignor(id: id, name: name, defaultSplitPct: split)
    }

    // MARK: - Report rollup

    func test_report_usesConsignorDefaultSplit() {
        let consignors = [consignor("c1", "Dana", split: 60)]
        let items = [
            ConsignmentReport.SoldConsignedItem(
                consignorId: "c1", splitPctOverride: nil, salePrice: 100, fees: 20
            ),
        ]
        let rows = ConsignmentReport.compute(soldItems: items, consignors: consignors)
        XCTAssertEqual(rows.count, 1)
        let row = rows[0]
        XCTAssertEqual(row.itemsSold, 1)
        XCTAssertEqual(row.netProceeds, 80, accuracy: 0.001)
        // 60% of net (80) = 48 owed; you keep 32.
        XCTAssertEqual(row.consignorPayout, 48, accuracy: 0.001)
        XCTAssertEqual(row.yourCut, 32, accuracy: 0.001)
    }

    func test_report_perItemSplitOverridesDefault() {
        let consignors = [consignor("c1", "Dana", split: 50)]
        let items = [
            ConsignmentReport.SoldConsignedItem(
                consignorId: "c1", splitPctOverride: 70, salePrice: 200, fees: 0
            ),
        ]
        let rows = ConsignmentReport.compute(soldItems: items, consignors: consignors)
        XCTAssertEqual(rows[0].consignorPayout, 140, accuracy: 0.001)
    }

    func test_report_aggregatesAndSortsByPayoutDesc() {
        let consignors = [consignor("c1", "Dana", split: 50), consignor("c2", "Eli", split: 50)]
        let items = [
            ConsignmentReport.SoldConsignedItem(consignorId: "c1", splitPctOverride: nil, salePrice: 50, fees: 0),
            ConsignmentReport.SoldConsignedItem(consignorId: "c2", splitPctOverride: nil, salePrice: 300, fees: 0),
            ConsignmentReport.SoldConsignedItem(consignorId: "c1", splitPctOverride: nil, salePrice: 50, fees: 0),
        ]
        let rows = ConsignmentReport.compute(soldItems: items, consignors: consignors)
        XCTAssertEqual(rows.count, 2)
        // Eli (150 owed) sorts before Dana (50 owed).
        XCTAssertEqual(rows[0].consignorName, "Eli")
        XCTAssertEqual(rows[0].consignorPayout, 150, accuracy: 0.001)
        XCTAssertEqual(rows[1].consignorName, "Dana")
        XCTAssertEqual(rows[1].itemsSold, 2)
        XCTAssertEqual(rows[1].consignorPayout, 50, accuracy: 0.001)
    }

    func test_report_netNegativeSaleDoesNotProduceNegativeOwed() {
        let consignors = [consignor("c1", "Dana", split: 50)]
        let items = [
            ConsignmentReport.SoldConsignedItem(
                consignorId: "c1", splitPctOverride: nil, salePrice: 10, fees: 25
            ),
        ]
        let rows = ConsignmentReport.compute(soldItems: items, consignors: consignors)
        XCTAssertEqual(rows[0].consignorPayout, 0, accuracy: 0.001)
    }

    func test_report_ignoresItemsWithUnknownConsignor() {
        let consignors = [consignor("c1", "Dana")]
        let items = [
            ConsignmentReport.SoldConsignedItem(consignorId: "ghost", splitPctOverride: nil, salePrice: 100, fees: 0),
        ]
        XCTAssertTrue(ConsignmentReport.compute(soldItems: items, consignors: consignors).isEmpty)
    }

    func test_report_convenienceJoinsSalesToConsignedItems() {
        let consignors = [consignor("c1", "Dana", split: 50)]
        let item = LocalInventoryItem(id: "i1", userId: "u1", title: "Jacket")
        item.consignorId = "c1"
        let nonConsigned = LocalInventoryItem(id: "i2", userId: "u1", title: "Shoes")
        let sale1 = LocalSale(id: "s1", inventoryItemId: "i1", salePrice: 100, saleDate: .now, platformFees: 0)
        let sale2 = LocalSale(id: "s2", inventoryItemId: "i2", salePrice: 80, saleDate: .now, platformFees: 0)

        let rows = ConsignmentReport.compute(
            items: [item, nonConsigned], sales: [sale1, sale2], consignors: consignors
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].itemsSold, 1)
        XCTAssertEqual(rows[0].consignorPayout, 50, accuracy: 0.001)
    }

    func test_report_convenienceExcludesCancelledAndRefundedSales() {
        // A reversed sale must not generate a payout the reseller never collected.
        let consignors = [consignor("c1", "Dana", split: 50)]
        let item = LocalInventoryItem(id: "i1", userId: "u1", title: "Jacket")
        item.consignorId = "c1"

        let completed = LocalSale(id: "s1", inventoryItemId: "i1", salePrice: 100, saleDate: .now, platformFees: 0)
        let refunded = LocalSale(id: "s2", inventoryItemId: "i1", salePrice: 100, saleDate: .now, platformFees: 0)
        refunded.status = "refunded"
        let cancelled = LocalSale(id: "s3", inventoryItemId: "i1", salePrice: 100, saleDate: .now, platformFees: 0)
        cancelled.status = "cancelled"

        let rows = ConsignmentReport.compute(
            items: [item], sales: [completed, refunded, cancelled], consignors: consignors
        )
        XCTAssertEqual(rows.count, 1)
        // Only the one completed sale counts.
        XCTAssertEqual(rows[0].itemsSold, 1)
        XCTAssertEqual(rows[0].grossRevenue, 100, accuracy: 0.001)
        XCTAssertEqual(rows[0].consignorPayout, 50, accuracy: 0.001)
    }

    func test_report_convenienceIncludesPaymentProcessingFees() {
        // Net proceeds must subtract platform + payment-processing fees (SalePnL.fees),
        // not platform fees alone, or the consignor is overpaid.
        let consignors = [consignor("c1", "Dana", split: 50)]
        let item = LocalInventoryItem(id: "i1", userId: "u1", title: "Jacket")
        item.consignorId = "c1"
        let sale = LocalSale(id: "s1", inventoryItemId: "i1", salePrice: 100, saleDate: .now, platformFees: 10)
        sale.paymentProcessingFees = 5

        let rows = ConsignmentReport.compute(
            items: [item], sales: [sale], consignors: consignors
        )
        XCTAssertEqual(rows.count, 1)
        // net = 100 − (10 + 5) = 85; 50% owed = 42.5.
        XCTAssertEqual(rows[0].fees, 15, accuracy: 0.001)
        XCTAssertEqual(rows[0].netProceeds, 85, accuracy: 0.001)
        XCTAssertEqual(rows[0].consignorPayout, 42.5, accuracy: 0.001)
    }

    // MARK: - Consignor draft

    func test_consignorDraft_validation() {
        var draft = ConsignorDraft()
        XCTAssertFalse(draft.isValid)  // blank name
        draft.name = "Dana"
        XCTAssertTrue(draft.isValid)
        draft.defaultSplitPct = 150
        XCTAssertFalse(draft.isValid)  // out of range
    }

    func test_consignor_decodesNumericSplit() throws {
        let json = #"""
        {"id":"c1","name":"Dana","contact_email":"d@x.com","contact_phone":null,"default_split_pct":62.5,"notes":null}
        """#
        let c = try JSONDecoder().decode(Consignor.self, from: Data(json.utf8))
        XCTAssertEqual(c.name, "Dana")
        XCTAssertEqual(c.defaultSplitPct, 62.5, accuracy: 0.001)
        XCTAssertEqual(c.contactEmail, "d@x.com")
        XCTAssertNil(c.contactPhone)
    }

    // MARK: - SKU label printing

    func test_labelPrinter_generatesBarcode() {
        XCTAssertNotNil(LabelPrinter.barcodeImage(from: "GT-12345"))
        XCTAssertNil(LabelPrinter.barcodeImage(from: ""))
    }

    func test_labelPrinter_throwsOnEmptySKU() {
        XCTAssertThrowsError(try LabelPrinter.makeLabelImage(sku: "   ", title: "Jacket")) { error in
            XCTAssertEqual(error as? LabelPrinter.LabelError, .emptySKU)
        }
    }

    func test_labelPrinter_makesLabelImage() throws {
        let image = try LabelPrinter.makeLabelImage(sku: "GT-999", title: "Vintage Denim Jacket")
        XCTAssertEqual(image.size, LabelPrinter.labelSize)
    }

    // MARK: - Location filter facet

    func test_filter_byLocationBin() {
        let a = LocalInventoryItem(id: "a", userId: "u", title: "A")
        a.locationBin = "Tote A3"
        a.status = "cataloged"
        let b = LocalInventoryItem(id: "b", userId: "u", title: "B")
        b.locationBin = "Rack 2"
        b.status = "cataloged"

        var criteria = InventoryFilterCriteria()
        criteria.locationBins = ["Tote A3"]
        XCTAssertTrue(InventoryFilter.matches(a, criteria))
        XCTAssertFalse(InventoryFilter.matches(b, criteria))
        XCTAssertEqual(criteria.activeCount, 1)
    }
}
