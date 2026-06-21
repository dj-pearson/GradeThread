import Foundation
import Observation
import SwiftData

/// Fetches + creates operating expenses (`flipdesk_expenses`). RLS scopes
/// every read to the caller (so `refresh` needs no user filter); the INSERT
/// must carry `user_id` because the column has no default and the policy's
/// WITH CHECK requires `auth.uid() = user_id`.
@MainActor
@Observable
final class ExpenseStore {
    enum Phase: Equatable {
        case loading
        case ready([RemoteExpense])
        case failed(String)
    }

    /// Outcome of a write — distinguishes a server-confirmed save from one that
    /// was queued offline (US-982) so the UI can tell the user "will sync".
    enum WriteResult: Equatable {
        case saved
        case savedOffline
        case failed(String)
    }

    var phase: Phase = .loading

    var expenses: [RemoteExpense] {
        if case let .ready(rows) = phase { return rows }
        return []
    }

    /// Sum of expenses dated in the current calendar month.
    func thisMonthTotal(now: Date = .now, calendar: Calendar = .current) -> Double {
        guard let startOfMonth = calendar.date(
            from: calendar.dateComponents([.year, .month], from: now)
        ) else { return 0 }
        // US-790: sum in exact Decimal so a month of expenses can't drift.
        return Money.sum(expenses.filter { $0.date >= startOfMonth }) { $0.amount }
    }

    func refresh() async {
        phase = .loading
        do {
            let response = try await SupabaseShared.client
                .from("flipdesk_expenses")
                .select("id, category, description, amount, spent_on")
                .order("spent_on", ascending: false)
                .limit(500)
                .execute()
            phase = .ready(Self.decodeResiliently(response.data))
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Inserts a new expense and mirrors it into the shared SwiftData cache so
    /// the Money tab's `@Query<LocalExpense>` updates immediately (US-750) — no
    /// separate server re-fetch. A true network failure (US-982) queues a
    /// `createExpense` mutation for replay; an app-level rejection surfaces.
    ///
    /// `inventoryItemId` / `listingId` are the optional 00266 attribution links
    /// (nil = general overhead). A client-generated `id` is sent so a queued
    /// replay upserts idempotently and the local mirror matches the server row.
    func create(
        category: ExpenseCategory,
        amount: Double,
        description: String?,
        spentOn: Date,
        inventoryItemId: String? = nil,
        listingId: String? = nil,
        userId: String,
        queueContext: ModelContext
    ) async -> WriteResult {
        struct Insert: Encodable {
            let id: String
            let user_id: String
            let category: String
            let description: String?
            let amount: Double
            let spent_on: String
            let inventory_item_id: String?
            let listing_id: String?
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"

        let id = UUID().uuidString
        let cleanDescription = description?.isEmpty == true ? nil : description
        let spentOnString = formatter.string(from: spentOn)
        let row = Insert(
            id: id,
            user_id: userId,
            category: category.rawValue,
            description: cleanDescription,
            amount: amount,
            spent_on: spentOnString,
            inventory_item_id: inventoryItemId,
            listing_id: listingId
        )
        do {
            try await SupabaseShared.client
                .from("flipdesk_expenses")
                .insert(row)
                .execute()
            mirrorCreated(
                id: id, category: category.rawValue, description: cleanDescription,
                amount: amount, spentOn: spentOn, inventoryItemId: inventoryItemId,
                listingId: listingId, queueContext: queueContext
            )
            return .saved
        } catch {
            // US-982: queue genuine connectivity failures; surface real rejections.
            guard OfflineMutationQueue.shouldQueue(error) else {
                return .failed(error.localizedDescription)
            }
            _ = OfflineMutationQueue.enqueueCreate(
                kind: .createExpense, payload: row, in: queueContext
            )
            mirrorCreated(
                id: id, category: category.rawValue, description: cleanDescription,
                amount: amount, spentOn: spentOn, inventoryItemId: inventoryItemId,
                listingId: listingId, queueContext: queueContext
            )
            return .savedOffline
        }
    }

    func delete(id: String, queueContext: ModelContext) async -> WriteResult {
        do {
            try await SupabaseShared.client
                .from("flipdesk_expenses")
                .delete()
                .eq("id", value: id)
                .execute()
            removeLocally(id: id, in: queueContext)
            return .saved
        } catch {
            guard OfflineMutationQueue.shouldQueue(error) else {
                return .failed(error.localizedDescription)
            }
            OfflineMutationQueue.enqueueDelete(
                kind: .deleteExpense, targetId: id, in: queueContext
            )
            removeLocally(id: id, in: queueContext)  // optimistic — replays on reconnect
            return .savedOffline
        }
    }

    /// Inserts the new expense into the shared SwiftData cache (idempotent by id)
    /// so it appears immediately and the next sync reconciles it server-side.
    private func mirrorCreated(
        id: String, category: String, description: String?, amount: Double,
        spentOn: Date, inventoryItemId: String?, listingId: String?,
        queueContext: ModelContext
    ) {
        let predicate = #Predicate<LocalExpense> { $0.id == id }
        if let existing = try? queueContext.fetch(FetchDescriptor<LocalExpense>(predicate: predicate)).first {
            existing.category = category
            existing.amount = amount
            existing.spentOn = spentOn
            existing.expenseDescription = description
            existing.inventoryItemId = inventoryItemId
            existing.listingId = listingId
        } else {
            queueContext.insert(LocalExpense(
                id: id, category: category, amount: amount, spentOn: spentOn,
                expenseDescription: description, inventoryItemId: inventoryItemId,
                listingId: listingId
            ))
        }
        queueContext.saveOrLog("mirrorCreated")
    }

    private func removeLocally(id: String, in queueContext: ModelContext) {
        let predicate = #Predicate<LocalExpense> { $0.id == id }
        if let row = try? queueContext.fetch(FetchDescriptor<LocalExpense>(predicate: predicate)).first {
            queueContext.delete(row)
            queueContext.saveOrLog("removeLocally")
        }
    }

    nonisolated static func decodeResiliently(_ data: Data) -> [RemoteExpense] {
        guard let rows = try? JSONDecoder().decode([Failable<RemoteExpense>].self, from: data)
        else { return [] }
        return rows.compactMap(\.value)
    }

    private struct Failable<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws {
            value = try? decoder.singleValueContainer().decode(T.self)
        }
    }
}
