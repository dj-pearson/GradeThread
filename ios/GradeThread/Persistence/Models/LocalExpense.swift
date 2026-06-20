import Foundation
import SwiftData

/// Local mirror of `flipdesk_expenses` (US-750). Before this, Expenses were the
/// last money surface still fetched independently from the server (via
/// `ExpenseStore`'s `RemoteExpense` read) instead of the shared SwiftData cache
/// that backs Sales / Listings / Inventory — so the Money tab's expense total
/// could drift from what a sync had last seen, and expenses couldn't be tied to
/// the item they offset.
///
/// `amount` is server-authoritative; `inventoryItemId` / `listingId` are the
/// optional attribution links added in migration 00266 so per-item P&L and
/// expense-by-source roll-ups become possible. NULL = general overhead (the
/// original behavior).
@Model
final class LocalExpense {
    // `spentOn` backs the Money/Expense list `@Query(sort:)`; `inventoryItemId`
    // backs the per-item expense join. `id` is covered by `@Attribute(.unique)`.
    #Index<LocalExpense>([\.spentOn], [\.inventoryItemId])

    @Attribute(.unique) var id: String
    /// Raw `expense_category` string (kept as the wire value; the view maps it
    /// through `ExpenseCategory(rawValue:)` like `RemoteExpense` does).
    var category: String
    var expenseDescription: String?
    var amount: Double
    var spentOn: Date

    /// 00266 attribution links — the item / listing this expense offsets, if any.
    var inventoryItemId: String?
    var listingId: String?

    var createdAt: Date

    init(
        id: String,
        category: String,
        amount: Double,
        spentOn: Date,
        expenseDescription: String? = nil,
        inventoryItemId: String? = nil,
        listingId: String? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.category = category
        self.amount = amount
        self.spentOn = spentOn
        self.expenseDescription = expenseDescription
        self.inventoryItemId = inventoryItemId
        self.listingId = listingId
        self.createdAt = createdAt
    }

    /// Convenience: the parsed category, falling back to `.other` for an
    /// unrecognized server string (same lenience as `RemoteExpense`).
    var categoryValue: ExpenseCategory { ExpenseCategory(rawValue: category) ?? .other }
}
