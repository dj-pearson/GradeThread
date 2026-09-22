import Foundation

/// US-3455 -- the two edge calls around an in-app listing, kept OUTSIDE
/// `Marketplaces/WebList` on purpose.
///
/// The code that drives the marketplace page may fetch nothing
/// (`ios/Scripts/check-web-delist.py`, App Review 4.7). The words it types and
/// the record it leaves behind are ordinary authenticated edge calls, so they
/// live here and are handed across as data: the fill goes IN before the sheet
/// opens, and the live URL comes OUT through a closure when the seller posts.
@MainActor
final class WebListService {

    static let shared = WebListService()

    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    private struct FillBody: Encodable {
        let inventoryItemId: String
        let platform: String
        let price: String?
    }

    private struct FillResponse: Decodable {
        let payload: Payload

        struct Payload: Decodable {
            let title: String?
            let description: String?
            let price: String?
            let brand: String?
            let photoUrls: [String]?
        }
    }

    /// The words for one item's form on one marketplace: the same title,
    /// description, price and brand a queued desktop job would type. The
    /// edge refuses an item with no photos in the words the desktop shows.
    func fill(itemId: String, platform: String, price: String?) async throws -> WebListFill {
        let body = FillBody(
            inventoryItemId: itemId,
            platform: platform,
            price: (price?.isEmpty ?? true) ? nil : price
        )
        let response: FillResponse = try await api.postJSON(
            "/api/flipdesk/extension-queue/fill",
            body: body
        )
        let p = response.payload
        return WebListFill(
            title: p.title ?? "",
            description: p.description ?? "",
            price: p.price ?? "",
            brand: p.brand ?? "",
            photoCount: p.photoUrls?.count ?? 0
        )
    }

    private struct WritebackBody: Encodable {
        let itemId: String
        let platform: String
        let listingUrl: String
        let published: Bool
    }

    private struct WritebackResponse: Decodable {}

    /// Record that the seller posted. The same writeback the desktop extension
    /// reports through, so the listings row gains the URL and reads live.
    func recordListed(itemId: String, platform: String, url: URL) async throws {
        let body = WritebackBody(
            itemId: itemId,
            platform: platform,
            listingUrl: url.absoluteString,
            published: true
        )
        let _: WritebackResponse = try await api.postJSON(
            "/api/flipdesk/listings/extension-writeback",
            body: body
        )
    }
}
