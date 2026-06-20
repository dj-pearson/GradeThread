import XCTest
@testable import GradeThread

/// US-751: reconciliation create/link now mirror the live eBay listing into the
/// `listings` table so the item's canvas shows where it's listed (instead of a
/// dead-end "0 listings"). These cover the pure orphan → listing-row mapping
/// that both paths feed to Supabase.
@MainActor
final class ReconcileListingMirrorTests: XCTestCase {

    private func orphan(
        ebayItemId: String = "1234567890",
        title: String? = "Vintage wool shirt",
        currentPrice: Double? = 38.0,
        listingURL: String? = "https://www.ebay.com/itm/1234567890"
    ) -> OrphanEbayListing {
        func jsonString(_ s: String?) -> String { s.map { "\"\($0)\"" } ?? "null" }
        func jsonNumber(_ d: Double?) -> String { d.map { String($0) } ?? "null" }
        let json = """
        {
          "id": "row-1",
          "ebay_item_id": "\(ebayItemId)",
          "custom_label": "S-12",
          "title": \(jsonString(title)),
          "current_price": \(jsonNumber(currentPrice)),
          "available_quantity": 1,
          "listing_url": \(jsonString(listingURL)),
          "listing_format": "FIXED_PRICE",
          "imported_at": "2026-05-01T12:00:00Z"
        }
        """
        return try! JSONDecoder().decode(OrphanEbayListing.self, from: Data(json.utf8))
    }

    func test_mirrorFields_passThroughTitleUrlAndPlatformId() {
        let fields = ReconciliationService.ebayListingMirrorFields(from: orphan())
        XCTAssertEqual(fields.platformListingId, "1234567890")
        XCTAssertEqual(fields.listingTitle, "Vintage wool shirt")
        XCTAssertEqual(fields.listingURL, "https://www.ebay.com/itm/1234567890")
        XCTAssertEqual(fields.listingPrice, 38.0, accuracy: 0.0001)
    }

    func test_mirrorFields_priceDefaultsToZero_titleAndUrlNilSafe() {
        let fields = ReconciliationService.ebayListingMirrorFields(
            from: orphan(title: nil, currentPrice: nil, listingURL: nil)
        )
        // No price on the orphan → 0 (a NOT-NULL listing_price, like the web).
        XCTAssertEqual(fields.listingPrice, 0, accuracy: 0.0001)
        XCTAssertNil(fields.listingTitle)
        XCTAssertNil(fields.listingURL)
        XCTAssertEqual(fields.platformListingId, "1234567890")
    }
}
