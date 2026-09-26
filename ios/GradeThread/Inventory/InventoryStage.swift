import Foundation

/// Stage grouping for the inventory triage tabs — mirrors the web
/// `TO_LIST_STATUSES` / `LISTED_STATUSES` etc. tab structure in
/// `src/pages/flipdesk/listings.tsx`. Each stage maps to a set of
/// canonical `inventory_items.status` values; an item belongs to the
/// stage whose status set contains its current status.
public enum InventoryStage: String, CaseIterable, Identifiable, Hashable {
    case all
    case toList     = "to_list"
    case drafts
    case active
    case sold
    case shipped
    case returned

    public var id: String { rawValue }

    /// Display label shown on the TabView item.
    public var label: String {
        switch self {
        case .all:      return "All"
        case .toList:   return "To list"
        case .drafts:   return "Drafts"
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
        case .toList:   return "tray.and.arrow.up"
        case .drafts:   return "doc.text"
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
        case .toList:   return "Nothing to list"
        case .drafts:   return "No drafts"
        case .active:   return "No active listings"
        case .sold:     return "No sales yet"
        case .shipped:  return "Nothing shipped yet"
        case .returned: return "No returns"
        }
    }

    public var emptyStateSubtitle: String {
        switch self {
        case .all:      return "Add an item from the + tab to get started."
        case .toList:   return "Catalog photos for an item to move it here."
        case .drafts:   return "Compose a listing draft for any cataloged item."
        case .active:   return "Push a draft to eBay to see it here."
        case .sold:     return "Sold items show here until they ship."
        case .shipped:  return "Items move here once you mark them shipped."
        case .returned: return "Returned sales appear here for reconciliation."
        }
    }

    /// Canonical `inventory_items.status` values that belong to this
    /// stage. Source of truth is the web `listings.tsx` tab predicate.
    public var matchingStatuses: Set<String> {
        switch self {
        case .all:
            return Set(InventoryStage.allKnownStatuses)
        case .toList:
            // Same set as TO_LIST_STATUSES on the web: anything pre-draft
            // that's already past sourcing — items the user could reasonably
            // start listing today.
            // US-3543: `grading` too. An item waiting on its grade is still
            // work to list, and it used to show under All and nowhere else.
            return ["sourced", "acquired", "cataloged", "measured", "photographed", "grading", "graded", "comped"]
        case .drafts:
            return ["drafted"]
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

    /// US-3543: the order a stage opens in. Sales read newest sale first (the
    /// web's Sold tab default); the work queue reads longest-waiting first, so
    /// the item that has sat the longest is the one on top.
    public var defaultSort: SortOption {
        switch self {
        case .sold, .shipped, .returned: return .recentSale
        case .toList, .drafts:           return .untouchedLongest
        case .all, .active:              return .newest
        }
    }

    /// US-3543: sorts that make sense in this stage. The sale sorts are only
    /// offered where sold items can appear.
    public var sortOptions: [SortOption] {
        switch self {
        case .all, .sold, .shipped, .returned:
            return SortOption.allCases
        case .toList, .drafts, .active:
            return SortOption.allCases.filter { !$0.isSaleSort }
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
        .all, .toList, .drafts, .active, .sold, .shipped, .returned,
    ]
}
