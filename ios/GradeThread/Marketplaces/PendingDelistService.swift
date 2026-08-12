import Foundation

/// US-2481 AC1: the phone's half of the auto-delist queue.
///
/// When a cross-listed item sells, the edge ends its siblings. On eBay/Shopify/
/// Depop it does that itself. On the extension channels there is no write API,
/// so all it can do is STAMP the listing (`listings.delist_requested_at`) and
/// wait for a browser — see
/// `vault/60-decisions/adr-no-server-side-marketplace-automation.md`.
///
/// Until this shipped, that stamp was only ever readable on the web dashboard.
/// A seller who sold on eBay from their phone, at a thrift store, had no way to
/// see that their Poshmark copy was still live and no way to do anything about
/// it — which is the double sale the whole queue exists to prevent, left in
/// place on the device the seller actually had with them.
///
/// So this reads the same endpoint the web banner reads and offers the same two
/// outs, in the same order of honesty:
///
///   1. Queue the delist for the desktop extension (`ExtensionQueueService`).
///      The listing is still live until the browser opens; the copy says so.
///   2. "I ended it myself" — clears the stamp, for the rows the extension can
///      never end (a draft that was never confirmed live, or one with no saved
///      URL). Same `delist-confirm` endpoint the web uses.
///
/// What it deliberately does NOT do is end anything from the phone. There is no
/// mechanism to; claiming otherwise is the thing the ADR refuses.
@MainActor
public final class PendingDelistService {

    public static let shared = PendingDelistService()

    private let api: EdgeAPI

    public init(api: EdgeAPI = .shared) {
        self.api = api
    }

    /// Mirrors the edge projection in `services/edge-functions/src/lib/pending-delists.ts`
    /// and the web's `PendingDelist` in `src/hooks/use-pending-delists.ts`.
    public struct PendingDelist: Codable, Identifiable, Sendable {
        public let listingId: String
        public let platform: String
        public let listingUrl: String?
        /// `draft` means GradeThread only ever prefilled this listing and never
        /// confirmed it went live. Distinct from "no URL", and it needs
        /// different words: telling a seller "no saved URL" for something that
        /// may never have been published sends them hunting for nothing.
        public let listingStatus: String?
        /// Confirmed live AND has a URL — the only rows the extension can end.
        public let autoDelistable: Bool?
        public let itemId: String
        public let itemTitle: String?
        public let requestedAt: String

        public var id: String { listingId }

        enum CodingKeys: String, CodingKey {
            case listingId = "listing_id"
            case platform
            case listingUrl = "listing_url"
            case listingStatus = "listing_status"
            case autoDelistable = "auto_delistable"
            case itemId = "item_id"
            case itemTitle = "item_title"
            case requestedAt = "requested_at"
        }
    }

    /// The channels the desktop extension can actually end a listing on.
    /// Mirrors `LISTER_EXTENSION_PLATFORMS` in `src/lib/lister-extension.ts`.
    public static let queueablePlatforms: Set<String> = [
        "poshmark", "mercari", "grailed", "vinted", "facebook",
    ]

    /// Why a row cannot be queued for the desktop, in the seller's words.
    /// `nil` means it can. Mirrors the degrade order in `useRunDelist`.
    public static func blockedReason(_ row: PendingDelist) -> String? {
        if !queueablePlatforms.contains(row.platform) {
            return "The extension doesn't handle \(row.platform). End this listing on the marketplace."
        }
        if row.listingStatus == "draft" {
            return "GradeThread only prefilled this listing and never confirmed it went live. Check the marketplace, and if you did publish it, end it there."
        }
        if (row.listingUrl ?? "").isEmpty {
            return "No saved listing URL, so nothing can open it for you. End this listing on the marketplace."
        }
        return nil
    }

    private struct PendingResponse: Decodable {
        let pending: [PendingDelist]?
    }

    private struct ConfirmBody: Encodable {
        let listing_id: String
    }

    private struct ConfirmResponse: Decodable {
        let ok: Bool?
    }

    /// Listings that sold elsewhere and are still up.
    public func pending() async throws -> [PendingDelist] {
        let response: PendingResponse = try await api.getJSON(
            "/api/flipdesk/listings/pending-delists"
        )
        return response.pending ?? []
    }

    /// Queue the end-this-listing instruction for the desktop extension.
    ///
    /// Throws rather than queueing when the row can't be run, because a queued
    /// job the drain will refuse is worse than no job: it reads as handled.
    @discardableResult
    public func queueForDesktop(_ row: PendingDelist) async throws -> ExtensionQueueService.QueueItem {
        if let reason = Self.blockedReason(row) {
            throw PendingDelistError.notQueueable(reason)
        }
        return try await ExtensionQueueService.shared.enqueue(
            kind: .delist,
            platform: row.platform,
            inventoryItemId: row.itemId,
            listingId: row.listingId,
            // The extension re-checks this against its own bundled host list
            // before opening anything (US-1876). Sending it is how the drain
            // knows WHICH listing; it is not what makes the URL trusted.
            payload: ["listingUrl": row.listingUrl ?? ""]
        )
    }

    /// "I ended it myself." Clears the stamp so the row stops nagging.
    ///
    /// Same endpoint as the web's `useMarkDelistDone`, and the same rule: this
    /// is only ever driven by the seller saying they did it. Nothing here
    /// infers it, because clearing a stamp on a listing that is still live is
    /// exactly the silence that produces a double sale.
    public func markEndedManually(listingId: String) async throws {
        let _: ConfirmResponse = try await api.postJSON(
            "/api/flipdesk/listings/delist-confirm",
            body: ConfirmBody(listing_id: listingId)
        )
    }
}

public enum PendingDelistError: LocalizedError {
    case notQueueable(String)

    public var errorDescription: String? {
        switch self {
        case .notQueueable(let reason): return reason
        }
    }
}
