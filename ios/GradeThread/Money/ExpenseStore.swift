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

    /// Inserts a new expense, then optimistically refreshes. A true network
    /// failure (US-982) queues a `createExpense` mutation for replay and mirrors
    /// the row locally so it shows immediately; an app-level rejection surfaces.
    func create(
        category: ExpenseCategory,
        amount: Double,
        description: String?,
        spentOn: Date,
        userId: String,
        queueContext: ModelContext
    ) async -> WriteResult {
        struct Insert: Encodable {
            let user_id: String
            let category: String
            let description: String?
            let amount: Double
            let spent_on: String
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"

        let cleanDescription = description?.isEmpty == true ? nil : description
        let spentOnString = formatter.string(from: spentOn)
        let row = Insert(
            user_id: userId,
            category: category.rawValue,
            description: cleanDescription,
            amount: amount,
            spent_on: spentOnString
        )
        do {
            try await SupabaseShared.client
                .from("flipdesk_expenses")
                .insert(row)
                .execute()
            await refresh()
            return .saved
        } catch {
            // US-982: queue genuine connectivity failures; surface real rejections.
            guard OfflineMutationQueue.shouldQueue(error) else {
                return .failed(error.localizedDescription)
            }
            let id = OfflineMutationQueue.enqueueCreate(
                kind: .createExpense, payload: row, in: queueContext
            ) ?? UUID().uuidString
            mirrorCreated(
                id: id, category: category.rawValue, description: cleanDescription,
                amount: amount, spentOn: spentOnString
            )
            return .savedOffline
        }
    }

    func delete(_ expense: RemoteExpense, queueContext: ModelContext) async -> WriteResult {
        do {
            try await SupabaseShared.client
                .from("flipdesk_expenses")
                .delete()
                .eq("id", value: expense.id)
                .execute()
            // Drop locally so the list updates without a round-trip.
            removeLocally(expense)
            return .saved
        } catch {
            guard OfflineMutationQueue.shouldQueue(error) else {
                return .failed(error.localizedDescription)
            }
            OfflineMutationQueue.enqueueDelete(
                kind: .deleteExpense, targetId: expense.id, in: queueContext
            )
            removeLocally(expense)  // optimistic — the queued delete replays on reconnect
            return .savedOffline
        }
    }

    /// Optimistically inserts an offline-created expense into the loaded list so
    /// it appears immediately, keeping the server's newest-first `spent_on` order.
    private func mirrorCreated(
        id: String, category: String, description: String?, amount: Double, spentOn: String
    ) {
        let expense = RemoteExpense(
            id: id, category: category, description: description, amount: amount, spentOn: spentOn
        )
        var rows = expenses
        rows.append(expense)
        // `spent_on` is "yyyy-MM-dd", so a lexical sort is chronological.
        rows.sort { $0.spentOn > $1.spentOn }
        phase = .ready(rows)
    }

    private func removeLocally(_ expense: RemoteExpense) {
        if case var .ready(rows) = phase {
            rows.removeAll { $0.id == expense.id }
            phase = .ready(rows)
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
