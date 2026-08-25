import Foundation

/// US-2876: what the product contains, as the web declares it.
///
/// `ToolsHubView` hand-wrote sixteen rows of icon + title + subtitle, and
/// `navGroups` in sidebar.tsx hand-wrote twenty-three more. Neither list knew
/// the other existed, so the two clients quietly diverged: Listing templates
/// and Prospect are on the phone and nowhere on the web, and Community
/// Insights is a top-level tool here and an Analytics tab there.
///
/// The table below is GENERATED from `src/lib/surfaces.ts` by
/// `scripts/generate-swift-mirrors.mjs`. Do not hand-edit it; edit the
/// TypeScript and re-run the generator. `npm run verify` fails when this file
/// and that one disagree.
struct ProductSurface: Identifiable, Hashable {
    /// Stable id, shared with the web registry. Never a URL.
    let id: String
    /// The `ToolRoute` / `ToolModule` case name this surface presents as.
    let route: String
    /// Exactly as the product spells it.
    let label: String
    /// One plain sentence saying what the destination is for.
    let summary: String
    /// Where the same surface lives on the web, when it lives there at all.
    /// Nil means this is a phone-only surface -- a real gap, not an oversight.
    let webLink: String?
}

extension ProductSurface {
    /// Every surface the web registry says iOS has.
    ///
    /// Presentation stays in ``ToolsHubView``: which section a row sits in,
    /// which SF Symbol it uses, and whether it pushes or presents a sheet are
    /// iOS decisions the web has no opinion about. What is shared is the list
    /// itself and the words on it.
    static let all: [ProductSurface] = [
    // BEGIN GENERATED TABLE (scripts/generate-swift-mirrors.mjs, from src/lib/surfaces.ts)
        ProductSurface(
            id: "snap",
            route: "snap",
            label: "Snap to Value",
            summary: "Photograph a garment and get a free condition and price read.",
            webLink: "/dashboard/snap"
        ),
        ProductSurface(
            id: "submissions",
            route: "grades",
            label: "Submissions",
            summary: "Every garment you have sent for grading, and its report.",
            webLink: "/dashboard/submissions"
        ),
        ProductSurface(
            id: "autolister",
            route: "autoLister",
            label: "AutoLister",
            summary: "Turn a pile of photos into drafted listings in one batch.",
            webLink: "/dashboard/flipdesk/autolister"
        ),
        ProductSurface(
            id: "scheduled-drops",
            route: "scheduledDrops",
            label: "Scheduled drops",
            summary: "Queue listings to publish when buyers are looking.",
            webLink: "/dashboard/flipdesk/scheduled-drops"
        ),
        ProductSurface(
            id: "verified",
            route: "verified",
            label: "Verified",
            summary: "Claim your public seller handle and trust badge.",
            webLink: "/dashboard/flipdesk/verified"
        ),
        ProductSurface(
            id: "listing-templates",
            route: "templates",
            label: "Listing templates",
            summary: "Reusable description, condition and policy presets for your listings.",
            webLink: nil
        ),
        ProductSurface(
            id: "scout",
            route: "scout",
            label: "Scout deals",
            summary: "Find underpriced eBay listings worth flipping.",
            webLink: "/dashboard/flipdesk/sourcing?tab=scout"
        ),
        ProductSurface(
            id: "sources",
            route: "sources",
            label: "Sources",
            summary: "Organize where your inventory comes from.",
            webLink: "/dashboard/flipdesk/sourcing?tab=sources"
        ),
        ProductSurface(
            id: "prospect",
            route: "prospect",
            label: "Prospect an item",
            summary: "Photograph an item in a store and get instant comps before you buy it.",
            webLink: nil
        ),
        ProductSurface(
            id: "consignment",
            route: "consignors",
            label: "Consignment",
            summary: "Your consignors, their items, and their payout splits.",
            webLink: "/dashboard/flipdesk/consignment"
        ),
        ProductSurface(
            id: "repricing",
            route: "repricing",
            label: "Repricing",
            summary: "Condition-aware price suggestions for listings that are already live.",
            webLink: "/dashboard/flipdesk/pricing?tab=repricing"
        ),
        ProductSurface(
            id: "automations",
            route: "automations",
            label: "Automations",
            summary: "Rules that act on their own when a listing sits too long or gets no views.",
            webLink: "/dashboard/flipdesk/pricing?tab=automations"
        ),
        ProductSurface(
            id: "reconciliation",
            route: "reconciliation",
            label: "Reconciliation",
            summary: "Match eBay listings you did not create here to items you own.",
            webLink: "/dashboard/flipdesk/money?view=reconcile"
        ),
        ProductSurface(
            id: "reconcile-intake",
            route: "reconcileIntake",
            label: "Reconcile photo dump",
            summary: "Send a batch of photos straight to a reconcile session.",
            webLink: "/dashboard/flipdesk/intake"
        ),
        ProductSurface(
            id: "community-insights",
            route: "communityInsights",
            label: "Community Insights",
            summary: "Anonymized sourcing and pricing benchmarks from other sellers.",
            webLink: "/dashboard/flipdesk/analytics/community"
        ),
        ProductSurface(
            id: "referrals",
            route: "referrals",
            label: "Referrals",
            summary: "Invite other resellers and earn credit when they grade.",
            webLink: "/dashboard/referrals"
        ),
    // END GENERATED TABLE
    ]

    /// The surface with this id, or nil.
    static func named(_ id: String) -> ProductSurface? {
        all.first { $0.id == id }
    }

    /// The surface presented by this `ToolRoute` / `ToolModule` case, or nil.
    static func forRoute(_ route: String) -> ProductSurface? {
        all.first { $0.route == route }
    }
}
