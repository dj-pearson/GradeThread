import Foundation

/// One unmatched eBay listing row pulled from `flipdesk_ebay_listings`.
/// Each row needs the user to choose Create-new / Link-existing / Ignore
/// before it disappears from the queue.
public struct OrphanEbayListing: Decodable, Identifiable, Equatable {
    public let id: String
    public let ebayItemId: String
    /// eBay's "Custom label" field — typically the seller's SKU. May be
    /// nil when the user hasn't set one on the listing.
    public let customLabel: String?
    public let title: String?
    public let currentPrice: Double?
    public let availableQuantity: Int?
    public let listingURL: String?
    public let listingFormat: String?
    public let importedAt: String

    private enum CodingKeys: String, CodingKey {
        case id
        case ebayItemId = "ebay_item_id"
        case customLabel = "custom_label"
        case title
        case currentPrice = "current_price"
        case availableQuantity = "available_quantity"
        case listingURL = "listing_url"
        case listingFormat = "listing_format"
        case importedAt = "imported_at"
    }

    /// Title to display in the queue row — falls back to "Listing
    /// {ebay_item_id}" when the eBay row didn't capture one.
    public var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return "Listing \(ebayItemId)"
    }

    /// Default title pre-filled into the Create sheet. Same fallback as
    /// `displayTitle` but exposed under a distinct name so the intent at
    /// call sites is obvious.
    public var suggestedTitle: String { displayTitle }
}

/// Outcome of a single match attempt (Create / Link / Ignore). The
/// reconciliation view aggregates these for the bulk path.
public struct ReconciliationOutcome: Equatable {
    public let orphanId: String
    public let kind: Kind

    public enum Kind: Equatable {
        case created(itemId: String)
        case linked(itemId: String)
        case ignored
        case failed(message: String)
    }

    public var isSuccess: Bool {
        switch kind {
        case .created, .linked, .ignored: return true
        case .failed:                     return false
        }
    }
}

/// Aggregated result of a bulk Create-All run. Mirrors
/// `BulkActionResult.summary` semantics for the toast.
public struct ReconciliationBulkResult: Equatable {
    public let succeeded: Int
    public let failures: [(orphanId: String, message: String)]

    public init(succeeded: Int, failures: [(String, String)]) {
        self.succeeded = succeeded
        self.failures = failures
    }

    public var summary: String {
        let total = succeeded + failures.count
        let unit = total == 1 ? "item" : "items"
        if failures.isEmpty { return "Created \(succeeded) \(unit) from eBay." }
        if succeeded == 0 { return "All \(total) \(unit) failed." }
        return "Created \(succeeded) of \(total) \(unit); \(failures.count) failed."
    }

    /// Equatable on a typealias around the tuple — Swift doesn't
    /// synthesize Equatable for tuples in struct properties.
    public static func == (lhs: ReconciliationBulkResult, rhs: ReconciliationBulkResult) -> Bool {
        guard lhs.succeeded == rhs.succeeded,
              lhs.failures.count == rhs.failures.count else { return false }
        for (a, b) in zip(lhs.failures, rhs.failures) where a.0 != b.0 || a.1 != b.1 {
            return false
        }
        return true
    }
}
