import Foundation

/// Stage grouping for the inventory triage tabs — mirrors the web tab
/// structure in `src/pages/flipdesk/inventory-tabs.ts`. Each stage maps to a
/// set of canonical `inventory_items.status` values; an item belongs to the
/// stage whose status set contains its current status.
///
/// `unlisted` replaced the separate To List and Drafts stages (2026-09-02,
/// with the web). They were one job, getting an item live, split at whether a
/// listing row existed yet; the split moved Create draft and Publish onto
/// different tabs and sent a seller back and forth. The same split survives
/// as ``UnlistedFilter``, a chip row inside the one tab.
public enum InventoryStage: String, CaseIterable, Identifiable, Hashable {
    case all
    case unlisted
    case active
    case sold
    case shipped
    case returned

    public var id: String { rawValue }

    /// Display label shown on the TabView item.
    public var label: String {
        switch self {
        case .all:      return "All"
        case .unlisted: return "Unlisted"
        case .active:   return "Active"
        case .sold:     return "Sold"
        case .shipped:  return "Shipped"
        case .returned: return "Returned"
        }
    }

    /// SF Symbol on the tab item.
    public var systemImage: String {
        switch self {
        case .all:      return "tray.full"
        case .unlisted: return "tray.and.arrow.up"
        case .active:   return "tag"
        case .sold:     return "dollarsign.circle"
        case .shipped:  return "shippingbox"
        case .returned: return "arrow.uturn.backward"
        }
    }

    /// Friendly empty-state message + CTA for when the user has no items
    /// in this stage. Mirrors the web copy.
    public var emptyStateTitle: String {
        switch self {
        case .all:      return "No items yet"
        case .unlisted: return "Nothing waiting to list"
        case .active:   return "No active listings"
        case .sold:     return "No sales yet"
        case .shipped:  return "Nothing shipped yet"
        case .returned: return "No returns"
        }
    }

    public var emptyStateSubtitle: String {
        switch self {
        case .all:      return "Add an item from the + tab to get started."
        case .unlisted: return "Items wait here from intake until you publish them."
        case .active:   return "Push a draft to eBay to see it here."
        case .sold:     return "Sold items show here until they ship."
        case .shipped:  return "Items move here once you mark them shipped."
        case .returned: return "Returned sales appear here for reconciliation."
        }
    }

    /// Every status before a draft exists — the Unlisted rows that still need
    /// a listing written. Same set as `TO_LIST_STATUSES` on the web, `grading`
    /// included: an item sitting with the grader is still unlisted, and leaving
    /// it out made it vanish from every tab but All.
    public static let preDraftStatuses: Set<String> = [
        "sourced", "acquired", "cataloged", "measured", "photographed",
        "grading", "graded", "comped",
    ]

    /// Canonical `inventory_items.status` values that belong to this
    /// stage. Source of truth is the web tab predicate in `inventory-tabs.ts`.
    public var matchingStatuses: Set<String> {
        switch self {
        case .all:
            return Set(InventoryStage.allKnownStatuses)
        case .unlisted:
            return InventoryStage.preDraftStatuses.union(["drafted"])
        case .active:
            return ["listed"]
        case .sold:
            return ["sold"]
        case .shipped:
            return ["shipped", "completed"]
        case .returned:
            return ["returned"]
        }
    }

    /// Every status the iOS app knows about. Used by `.all` and for
    /// defensive filtering.
    public static let allKnownStatuses: [String] = [
        "sourced", "acquired", "cataloged", "measured", "photographed",
        "grading", "graded", "comped", "drafted",
        "listed", "sold", "shipped", "completed", "returned",
        "archived", "keeping", "wearing",
    ]

    /// Stages surfaced in the TabView, in display order. Excludes
    /// `archived/keeping/wearing` which aren't worth a top-level tab —
    /// the web hides them too.
    public static let userFacing: [InventoryStage] = [
        .all, .unlisted, .active, .sold, .shipped, .returned,
    ]

    /// The chip row inside Unlisted: the old To List / Drafts split, as a
    /// filter the seller can see. The web has a fourth chip, Needs review,
    /// off the draft's AI review flag; the local cache does not carry that
    /// flag, so here every draft is one chip.
    public enum UnlistedFilter: String, CaseIterable, Identifiable, Hashable {
        case all
        case needsDraft = "needs_draft"
        case drafted

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .all:        return "All"
            case .needsDraft: return "Needs draft"
            case .drafted:    return "Drafted"
            }
        }

        /// Whether an Unlisted row passes the chip. Only meaningful for rows
        /// the stage already matches.
        public func matches(_ status: String) -> Bool {
            switch self {
            case .all:        return true
            case .needsDraft: return InventoryStage.preDraftStatuses.contains(status)
            case .drafted:    return status == "drafted"
            }
        }
    }
}
