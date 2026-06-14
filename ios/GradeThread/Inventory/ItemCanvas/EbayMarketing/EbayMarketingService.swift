import Foundation

/// Per-listing eBay Promoted Listings + markdown Sale status (US-1044 / US-1045).
struct EbayPromotionStatus: Decodable, Equatable {
    let optOut: Bool
    let ratePct: Double?
    let adId: String?
    let status: String?
    let suggestedRatePct: Double
    let saleActive: Bool
    let salePct: Double?
}

/// Edge client for per-listing promotion + Sale controls. Behind a protocol so
/// the store is testable.
protocol EbayMarketingProviding {
    func promotion(listingId: String) async throws -> EbayPromotionStatus
    func setPromotion(listingId: String, ratePct: Double) async throws
    func removePromotion(listingId: String) async throws
    func startSale(listingId: String, percentOff: Double) async throws
    func endSale(listingId: String) async throws
}

struct EbayMarketingService: EbayMarketingProviding {
    private struct OKResponse: Decodable { let ok: Bool? }

    func promotion(listingId: String) async throws -> EbayPromotionStatus {
        try await EdgeAPI.shared.getJSON("/api/flipdesk/ebay/listings/\(listingId)/promotion")
    }

    func setPromotion(listingId: String, ratePct: Double) async throws {
        struct Body: Encodable { let ratePct: Double }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/listings/\(listingId)/promotion",
            body: Body(ratePct: ratePct)
        )
    }

    func removePromotion(listingId: String) async throws {
        let _: OKResponse = try await EdgeAPI.shared.deleteJSON(
            "/api/flipdesk/ebay/listings/\(listingId)/promotion"
        )
    }

    func startSale(listingId: String, percentOff: Double) async throws {
        struct Body: Encodable { let percentOff: Double }
        let _: OKResponse = try await EdgeAPI.shared.postJSON(
            "/api/flipdesk/ebay/listings/\(listingId)/sale",
            body: Body(percentOff: percentOff)
        )
    }

    func endSale(listingId: String) async throws {
        let _: OKResponse = try await EdgeAPI.shared.deleteJSON(
            "/api/flipdesk/ebay/listings/\(listingId)/sale"
        )
    }
}
