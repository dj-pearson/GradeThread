import Foundation

/// US-3105 — which lifecycle actions an extension-channel listing offers.
///
/// The phone could queue a first listing and a delist. It could not carry an
/// edit or a relist, so a seller who dropped a price in a shop had no way to
/// get that price onto their Poshmark listing until they were back at a desk,
/// and the listing sat there advertising the old one to every buyer who saw it.
///
/// PURE, and separate from the view, because the rules here are the ones that
/// decide whether a seller is told something true. Each is stated as its own
/// reason rather than folded into one boolean.
enum ExtensionLifecycle {

    /// The channels the desktop extension can revise or relist.
    ///
    /// DERIVED from the delist set on the server for a stated reason
    /// (`EXTENSION_REVISE_PLATFORMS` and `EXTENSION_RELIST_PLATFORMS` are both
    /// `[...EXTENSION_DELIST_PLATFORMS]`): a second hand-written list of "the
    /// extension channels" is how Vinted silently dropped out of a queue once.
    /// This mirror is the same list `PendingDelistService.queueablePlatforms`
    /// carries, and `ExtensionLifecycleTests` pins the two together.
    static let platforms: Set<String> = PendingDelistService.queueablePlatforms

    /// Grailed's delete is confirmed by a NATIVE browser dialog that nothing in
    /// a page can answer, so its delist is permanently impossible rather than
    /// unfinished (extension-unified/README.md, phase 3). A relist there
    /// therefore leaves the OLD listing live, and the seller has to end it by
    /// hand — which they must be told BEFORE they queue it, not after they have
    /// two copies of one garment on sale.
    static let relistLeavesOldListingLive: Set<String> = ["grailed"]

    /// What a listing is eligible for.
    struct Actions: Equatable {
        /// Fields that differ from what is published. Empty = nothing to send.
        let reviseFields: [ExtensionQueueService.ReviseField]
        let canRelist: Bool
        /// The sentence to show before a relist, when there is one to show.
        let relistWarning: String?

        var canRevise: Bool { !reviseFields.isEmpty }
        var hasAny: Bool { canRevise || canRelist }

        static let none = Actions(reviseFields: [], canRelist: false, relistWarning: nil)
    }

    /// One listing's eligibility.
    ///
    /// - `platform` / `status` / `hasUrl` come off the local mirror.
    /// - `targetPrice` is the item's current price; `listedPrice` is what the
    ///   listing carries. A difference between them is the ONE reliable
    ///   "changed since it went live" signal the phone holds.
    ///
    /// **Why price only.** `LocalListing` mirrors the listing price and nothing
    /// else — title and description are not synced to the device (the same
    /// limitation `listingPriceUnsynced` states for eBay). Naming `title` or
    /// `description` in a revise the phone cannot actually detect would queue
    /// work the desktop then finds nothing to do, and the marker would sit on
    /// the listing saying it was stale when it was not. So the phone reports
    /// what it can see, and the web keeps the fuller edit.
    static func actions(
        platform: String,
        status: String,
        hasUrl: Bool,
        targetPrice: Double?,
        listedPrice: Double
    ) -> Actions {
        guard platforms.contains(platform) else { return .none }
        // Only a listing that is genuinely up can be edited or copied. A draft
        // GradeThread only ever prefilled was never published, and queueing
        // against it produces a job the drain refuses — which reads to the
        // seller as handled.
        guard status == "active" || status == "relisted" else { return .none }
        // The extension opens the listing by its URL and host-pins it (US-1876).
        // With no URL there is nothing to open.
        guard hasUrl else { return .none }

        var fields: [ExtensionQueueService.ReviseField] = []
        if let targetPrice, abs(targetPrice - listedPrice) >= 0.01 {
            fields.append(.price)
        }

        return Actions(
            reviseFields: fields,
            canRelist: true,
            relistWarning: relistLeavesOldListingLive.contains(platform)
                ? String(localized: "Grailed listings can only be deleted with a confirmation GradeThread cannot answer, so the old listing stays up. End it yourself once the copy is live.")
                : nil
        )
    }

    /// "Stale on Poshmark since 12 Aug" — the marker the server stamps, in the
    /// seller's words.
    ///
    /// Shown until the drain confirms, and worded as a fact about the listing
    /// rather than about the queue: the seller cares that the marketplace has
    /// the old price, not that a row exists in a table.
    static func staleLabel(platform: String, since: Date, now: Date = .now) -> String {
        let label = platformLabel(platform)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return String(localized: "Stale on \(label) since \(formatter.string(from: since))")
    }

    /// Display name for a platform id. Capitalized is right for every extension
    /// channel except Facebook Marketplace, which has a name rather than a word.
    static func platformLabel(_ platform: String) -> String {
        switch platform {
        case "facebook": return "Facebook Marketplace"
        default: return platform.capitalized
        }
    }
}
