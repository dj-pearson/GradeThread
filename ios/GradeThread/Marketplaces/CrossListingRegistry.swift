import Foundation

/// US-3103 — which marketplaces a draft can be pushed to, and how each is reached.
///
/// ⚠ **MIRROR. The TypeScript is the source.** `CROSS_LISTING_PLATFORMS`,
/// `MARKETPLACE_TIER` and `MARKETPLACE_MECHANISM` in `src/lib/constants.ts` are
/// authoritative; this is a hand-mirror for the phone, exactly as
/// `ChannelTier.badge` mirrors `MARKETPLACE_TIER_LABEL` in MarketplacesView.
/// Change the TypeScript first.
///
/// The drift is not hypothetical and it is not cosmetic. Mercari, Grailed and
/// Vinted spent months rendering "Connect via browser extension" while their
/// selectors sat disabled and every attempt reported "list manually for now"
/// (US-2477..US-2480). A seller reading a badge that overstates a channel
/// cross-posts into nothing and finds out days later. So this file is pinned by
/// `src/test/ios-cross-listing-registry.test.ts`, which parses BOTH files and
/// fails the build when they disagree — a guard that runs on every machine,
/// unlike an XCTest, which needs macOS.
enum CrossListingRegistry {

    /// How a channel is actually reached.
    enum Mechanism: String {
        /// A server-side connector: the edge publishes it directly.
        case api
        /// The GradeThread Lister, running in the seller's own logged-in tab.
        /// The phone can only QUEUE these; the desktop runs them.
        case extensionLister = "extension"
        /// No integration at all.
        case none
    }

    /// What the seller can honestly do right now — which is a different
    /// question from how the channel is reached. Depop is mechanism `api` and
    /// tier `apiPending`, because the connector exists and the approval does not.
    enum Tier: String {
        case api
        case apiPending = "api_pending"
        case extensionLister = "extension"
        case comingSoon = "coming_soon"

        /// The chip's label. Mirrors `MARKETPLACE_TIER_LABEL`.
        var label: String {
            switch self {
            case .api: return String(localized: "API")
            case .apiPending: return String(localized: "Awaiting approval")
            case .extensionLister: return String(localized: "Browser extension")
            case .comingSoon: return String(localized: "Coming soon")
            }
        }

        /// Whether a chip can be selected at all.
        ///
        /// `apiPending` is NOT selectable: the connector is built but the
        /// channel is unapproved, so a push would fail at the marketplace with
        /// an error the seller cannot act on. Offering it would be the same
        /// overstatement this file exists to prevent.
        var isSelectable: Bool {
            switch self {
            case .api, .extensionLister: return true
            case .apiPending, .comingSoon: return false
            }
        }
    }

    struct Channel: Identifiable, Equatable {
        let id: String
        let label: String
        let tier: Tier
        let mechanism: Mechanism

        var isSelectable: Bool { tier.isSelectable }
    }

    /// The cross-listing channels, in the order `CROSS_LISTING_PLATFORMS`
    /// declares them, MINUS eBay.
    ///
    /// eBay is excluded on purpose and not as an oversight: it has its own
    /// publish path with its own policies, specifics and format, which is the
    /// composer this sheet is opened from. Offering it here would give a seller
    /// two different ways to publish to eBay that carry different fields.
    static let channels: [Channel] = [
        Channel(id: "shopify", label: "Shopify", tier: .api, mechanism: .api),
        Channel(id: "poshmark", label: "Poshmark", tier: .extensionLister, mechanism: .extensionLister),
        Channel(id: "mercari", label: "Mercari", tier: .extensionLister, mechanism: .extensionLister),
        Channel(id: "depop", label: "Depop", tier: .apiPending, mechanism: .api),
        Channel(id: "etsy", label: "Etsy", tier: .apiPending, mechanism: .api),
        Channel(id: "whatnot", label: "Whatnot", tier: .comingSoon, mechanism: .none),
    ]

    static func channel(id: String) -> Channel? {
        channels.first { $0.id == id }
    }

    /// The selectable channels split by how a push reaches them.
    ///
    /// This split IS the feature: an API channel is published server-side and is
    /// live when the call returns, while an extension channel can only be queued
    /// for a desktop browser that may not be open for hours. Telling a seller
    /// those are the same thing is how "cross-posted" comes to mean nothing.
    static func partition(selected: Set<String>) -> (api: [Channel], extensionQueued: [Channel]) {
        let picked = channels.filter { selected.contains($0.id) && $0.isSelectable }
        return (
            api: picked.filter { $0.mechanism == .api },
            extensionQueued: picked.filter { $0.mechanism == .extensionLister }
        )
    }
}
