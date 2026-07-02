import XCTest
@testable import GradeThread

/// US-1517: the global-search match computation, extracted from the view so it
/// runs once per debounced query instead of per body pass. These pin the
/// behavior the AC requires stays identical: same matches, same joins, same
/// caps as the old live computed properties.
final class GlobalSearchResultsTests: XCTestCase {

    private func item(_ id: String, title: String, brand: String? = nil) -> LocalInventoryItem {
        let item = LocalInventoryItem(id: id, userId: "u", title: title, status: "sourced")
        item.brand = brand
        return item
    }

    private func listing(_ id: String, itemId: String, platform: String = "ebay") -> LocalListing {
        LocalListing(
            id: id, inventoryItemId: itemId, platform: platform,
            listingPrice: 10, listingStatus: "active"
        )
    }

    private func sale(_ id: String, itemId: String, buyer: String? = nil) -> LocalSale {
        let sale = LocalSale(id: id, inventoryItemId: itemId, salePrice: 20, saleDate: .now)
        sale.buyerUsername = buyer
        return sale
    }

    func test_compute_matchesTitleAndBrand_blankQueryEmpty() {
        let items = [
            item("a", title: "Levi's 501 jeans"),
            item("b", title: "Plain tee", brand: "Patagonia"),
            item("c", title: "Unrelated"),
        ]
        let hits = GlobalSearchResults.compute(
            query: "levi", items: items, listings: [], sales: [], sources: []
        )
        XCTAssertEqual(hits.items.map(\.id), ["a"])

        let brandHits = GlobalSearchResults.compute(
            query: "patagonia", items: items, listings: [], sales: [], sources: []
        )
        XCTAssertEqual(brandHits.items.map(\.id), ["b"])

        // Blank / whitespace query → empty result set (the view shows recents).
        XCTAssertTrue(
            GlobalSearchResults.compute(
                query: "   ", items: items, listings: [], sales: [], sources: []
            ).isEmpty
        )
    }

    func test_compute_joinsListingAndSaleHits_dropsOrphans() {
        let items = [item("a", title: "Levi's 501 jeans")]
        let listings = [
            listing("l1", itemId: "a"),               // matches via item title
            listing("l2", itemId: "MISSING"),         // orphan — US-1187: dropped
        ]
        let sales = [
            sale("s1", itemId: "a", buyer: "levifan"), // matches via buyer
            sale("s2", itemId: "MISSING", buyer: "levibuyer"), // orphan — dropped
        ]
        let hits = GlobalSearchResults.compute(
            query: "levi", items: items, listings: listings, sales: sales, sources: []
        )
        XCTAssertEqual(hits.listings.map(\.id), ["l1"])
        XCTAssertEqual(hits.listings.first?.item.id, "a")
        XCTAssertEqual(hits.sales.map(\.id), ["s1"])
        XCTAssertEqual(hits.sales.first?.item.id, "a")
        XCTAssertFalse(hits.isEmpty)
    }

    func test_compute_capsEachSectionAtTwenty() {
        let items = (0..<30).map { item("i\($0)", title: "Levi's \($0)") }
        let hits = GlobalSearchResults.compute(
            query: "levi", items: items, listings: [], sales: [], sources: []
        )
        XCTAssertEqual(hits.items.count, 20)
    }

    func test_compute_matchesSources() {
        let sources = [
            LocalSource(id: "src1", userId: "u", name: "Goodwill bins", sourceType: "thrift"),
            LocalSource(id: "src2", userId: "u", name: "Estate sale"),
        ]
        let hits = GlobalSearchResults.compute(
            query: "goodwill", items: [], listings: [], sales: [], sources: sources
        )
        XCTAssertEqual(hits.sources.map(\.id), ["src1"])
    }
}
