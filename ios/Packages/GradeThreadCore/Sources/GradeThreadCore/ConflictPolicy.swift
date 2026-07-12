import Foundation

/// Field-level merge rules between a locally-cached row and a freshly-pulled
/// server row. Same policy the web app uses for FlipDesk ↔ eBay ↔ Sheets
/// reconciliation (see PRD US-148 and services/edge-functions/src/lib/
/// for the server-side equivalent).
///
/// The split is:
///
/// - **Server-wins** — marketplace-owned fields. eBay or another platform
///   writes them; user edits in the client are advisory at best. Examples:
///   `listing_price`, `listing_status`, `sale_price`, `platform_fees`,
///   `payout_reference`, `tracking_number`, `grade_value`.
///
/// - **Client-wins-if-locally-edited** — user-owned fields. The client is
///   the freshest source while the user is actively editing; we only
///   defer to the server when the local row has no pending changes. The
///   `hasLocalChanges` flag on each model marks the row dirty. Examples:
///   `title`, `brand`, `condition_notes`, `target_price`, `measurements`.
///
/// - **Newest-write-wins** — neutral fields, decided by comparing the
///   `updatedAt` timestamps. Falls through whenever neither side claims
///   precedence (e.g. `notes`, `sku`).
///
/// Pure Foundation logic — lives in GradeThreadCore so it is unit-tested on
/// Linux (no SwiftData / UIKit), and consumed by the iOS app via `import
/// GradeThreadCore`.
public enum ConflictPolicy {

    /// Picks the post-merge value for a server-authoritative field. Server
    /// always wins because no client edit makes sense for these.
    public static func resolveServerOwned<T>(local: T, server: T) -> T {
        server
    }

    /// Picks the post-merge value for a user-edited field. If the local
    /// row has unflushed local changes we keep the local value; otherwise
    /// the server wins.
    public static func resolveUserOwned<T: Equatable>(
        local: T,
        server: T,
        hasLocalChanges: Bool
    ) -> T {
        hasLocalChanges ? local : server
    }

    /// Picks the post-merge value for a neutral field by comparing the
    /// row-level `updatedAt` timestamps.
    public static func resolveByTimestamp<T>(
        local: T,
        server: T,
        localUpdatedAt: Date,
        serverUpdatedAt: Date
    ) -> T {
        serverUpdatedAt >= localUpdatedAt ? server : local
    }

    // MARK: - Listing provenance (US-1086)

    /// Source of truth for a listing's eBay-owned editable fields, decided by
    /// `listing_origin`. See SYNC_SOURCE_OF_TRUTH.md for the full contract.
    enum ListingOrigin: String {
        case gradethread
        case ebay
    }

    /// Resolves an eBay-owned listing field (title, price, condition, quantity,
    /// description, policies) based on listing provenance.
    ///
    /// - eBay-originated: server always wins — eBay is the source of truth and
    ///   the iOS client must not overwrite these fields.
    /// - GradeThread-originated (or unknown): same as ``resolveUserOwned`` —
    ///   local wins while dirty, server wins when clean.
    public static func resolveEbayOwnedListingField<T: Equatable>(
        local: T,
        server: T,
        hasLocalChanges: Bool,
        listingOrigin: String?
    ) -> T {
        guard ListingOrigin(rawValue: listingOrigin ?? "") != .ebay else {
            return server
        }
        return resolveUserOwned(local: local, server: server, hasLocalChanges: hasLocalChanges)
    }
}
