import XCTest
import SwiftData
@testable import GradeThread

/// US-967: the list, Money, and Dashboard screens memoize their per-render
/// derived collections behind cheap integer signatures so an unrelated `body`
/// re-evaluation doesn't rebuild them. These tests pin the pure signature/build
/// helpers the views feed into `.onChange` — a stable input yields a stable
/// signature (memo holds), and a genuine input change flips it (memo rebuilds).
@MainActor
final class PerRenderMemoTests: XCTestCase {

    // MARK: - MoneyView.titlesByItemId (AC #2)

    func test_moneyTitlesSignature_stableUntilItemSetOrTitleChanges() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", title: "Nike Tee", context: context),
                     makeItem(id: "b", title: "Levi's 501", context: context)]

        let sig = MoneyView.titlesSignature(items)
        // Same snapshot across many `body` passes → identical signature.
        XCTAssertEqual(sig, MoneyView.titlesSignature(items))

        // Renaming a title is a genuine change.
        items[0].title = "Nike Dri-FIT Tee"
        XCTAssertNotEqual(sig, MoneyView.titlesSignature(items))

        // Adding an item is a genuine change.
        let grown = items + [makeItem(id: "c", title: "Carhartt", context: context)]
        XCTAssertNotEqual(MoneyView.titlesSignature(items), MoneyView.titlesSignature(grown))
    }

    func test_moneyBuildTitlesByItemId_mapsIdToTitle() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", title: "Nike Tee", context: context),
                     makeItem(id: "b", title: "Levi's 501", context: context)]
        let map = MoneyView.buildTitlesByItemId(items)
        XCTAssertEqual(map["a"], "Nike Tee")
        XCTAssertEqual(map["b"], "Levi's 501")
        XCTAssertNil(map["missing"])
    }

    // MARK: - DashboardView.trendPoints (AC #3)

    func test_dashboardTrendSignature_stableUntilSalesOrCostChange() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", title: "Tee", context: context)]
        items[0].acquiredPrice = 5
        let sales = [makeSale(id: "s1", itemId: "a", price: 20, context: context)]

        let sig = DashboardView.trendSignature(sales: sales, items: items)
        XCTAssertEqual(sig, DashboardView.trendSignature(sales: sales, items: items))

        // A new sale changes the series.
        let moreSales = sales + [makeSale(id: "s2", itemId: "a", price: 30, context: context)]
        XCTAssertNotEqual(sig, DashboardView.trendSignature(sales: moreSales, items: items))

        // Changing an item's cost basis changes the profit series.
        items[0].acquiredPrice = 7
        XCTAssertNotEqual(sig, DashboardView.trendSignature(sales: sales, items: items))
    }

    // MARK: - DashboardView rollup subsets (US-1263)

    func test_dashboardDerivedSignature_stableUntilARollupFieldChanges() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", title: "Tee", context: context),
                     makeItem(id: "b", title: "Jeans", context: context)]
        items[0].status = "listed"
        let sales = [makeSale(id: "s1", itemId: "a", price: 20, context: context)]

        let sig = DashboardView.derivedSignature(items: items, sales: sales)
        // Same snapshot across many `body` passes → identical signature.
        XCTAssertEqual(sig, DashboardView.derivedSignature(items: items, sales: sales))

        // A status change moves on-hand / listed / aging counts.
        items[1].status = "listed"
        let afterStatus = DashboardView.derivedSignature(items: items, sales: sales)
        XCTAssertNotEqual(sig, afterStatus)

        // Grading an item changes the graded subset.
        items[0].gradeValue = 8.5
        let afterGrade = DashboardView.derivedSignature(items: items, sales: sales)
        XCTAssertNotEqual(afterStatus, afterGrade)

        // A new sale changes the week rollup.
        let moreSales = sales + [makeSale(id: "s2", itemId: "b", price: 30, context: context)]
        XCTAssertNotEqual(afterGrade, DashboardView.derivedSignature(items: items, sales: moreSales))
    }

    // MARK: - MoneyView analytics rollups (US-1517)

    /// The Money tab's five analytics rollups are cached on this signature — it
    /// must be stable for identical data on the same day (so the cache holds
    /// across body passes) and change when a rollup input or the day changes.
    func test_moneyRollupSignature_stableForSameData_changesOnEditOrDay() throws {
        let context = ModelContext(try makeContainer())
        let items = [makeItem(id: "a", title: "Tee", context: context)]
        let sales = [makeSale(id: "s1", itemId: "a", price: 20, context: context)]
        let now = Date(timeIntervalSince1970: 1_700_000_000)

        let sig = MoneyView.rollupSignature(
            items: items, sales: sales, expenses: [], sources: [], now: now
        )
        // Same data, same day (a minute later) → same signature.
        XCTAssertEqual(sig, MoneyView.rollupSignature(
            items: items, sales: sales, expenses: [], sources: [], now: now.addingTimeInterval(60)
        ))

        // A money-field edit is a genuine change.
        sales[0].salePrice = 25
        XCTAssertNotEqual(sig, MoneyView.rollupSignature(
            items: items, sales: sales, expenses: [], sources: [], now: now
        ))
        sales[0].salePrice = 20

        // Day rollover recomputes day-granular figures ("this month", aging).
        XCTAssertNotEqual(sig, MoneyView.rollupSignature(
            items: items, sales: sales, expenses: [], sources: [], now: now.addingTimeInterval(86_400)
        ))
    }

    // MARK: - ItemCanvasView per-render derivations (AC #4)

    func test_itemEditableSignature_stableUntilAnEditableFieldChanges() throws {
        let context = ModelContext(try makeContainer())
        let item = makeItem(id: "a", title: "Tee", context: context)

        let sig = ItemCanvasView.editableSignature(item)
        // A non-editable bump (updatedAt) must NOT change the signature — that's
        // what stops a realtime touch from triggering a redundant refresh.
        item.updatedAt = item.updatedAt.addingTimeInterval(60)
        XCTAssertEqual(sig, ItemCanvasView.editableSignature(item))

        // Each editable field flip is a genuine change.
        item.title = "Dri-FIT Tee"
        let afterTitle = ItemCanvasView.editableSignature(item)
        XCTAssertNotEqual(sig, afterTitle)

        item.targetPrice = 42
        XCTAssertNotEqual(afterTitle, ItemCanvasView.editableSignature(item))

        let afterPrice = ItemCanvasView.editableSignature(item)
        item.locationBin = "BIN-12"
        XCTAssertNotEqual(afterPrice, ItemCanvasView.editableSignature(item))
    }

    func test_decodeMeasurements_parsesJSONAndTolerates() {
        XCTAssertNil(ItemCanvasView.decodeMeasurements(nil))
        XCTAssertNil(ItemCanvasView.decodeMeasurements("not json"))

        let parsed = ItemCanvasView.decodeMeasurements(#"{"chest": 22.5, "length": 28}"#)
        XCTAssertEqual(parsed?["chest"], 22.5)
        XCTAssertEqual(parsed?["length"], 28)
    }

    // MARK: - Helpers

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalSource.self,
            LocalSourcer.self,
            LocalPendingMutation.self,
        ])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        return try ModelContainer(for: schema, configurations: config)
    }

    private func makeItem(id: String, title: String, context: ModelContext) -> LocalInventoryItem {
        let item = LocalInventoryItem(
            id: id, userId: "u", title: title, status: "cataloged",
            createdAt: Date(timeIntervalSince1970: 1_000),
            updatedAt: Date(timeIntervalSince1970: 1_000)
        )
        context.insert(item)
        return item
    }

    private func makeSale(id: String, itemId: String, price: Double, context: ModelContext) -> LocalSale {
        let sale = LocalSale(
            id: id, inventoryItemId: itemId, salePrice: price,
            saleDate: Date(timeIntervalSince1970: 1_700_000_000), platformFees: 2
        )
        context.insert(sale)
        return sale
    }
}
