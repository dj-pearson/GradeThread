import Foundation
import Observation

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
        return expenses
            .filter { $0.date >= startOfMonth }
            .reduce(0.0) { $0 + $1.amount }
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

    /// Inserts a new expense, then optimistically refreshes. Returns nil on
    /// success or an error message on failure.
    func create(
        category: ExpenseCategory,
        amount: Double,
        description: String?,
        spentOn: Date,
        userId: String
    ) async -> String? {
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

        let row = Insert(
            user_id: userId,
            category: category.rawValue,
            description: description?.isEmpty == true ? nil : description,
            amount: amount,
            spent_on: formatter.string(from: spentOn)
        )
        do {
            try await SupabaseShared.client
                .from("flipdesk_expenses")
                .insert(row)
                .execute()
            await refresh()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func delete(_ expense: RemoteExpense) async -> String? {
        do {
            try await SupabaseShared.client
                .from("flipdesk_expenses")
                .delete()
                .eq("id", value: expense.id)
                .execute()
            // Drop locally so the list updates without a round-trip.
            if case var .ready(rows) = phase {
                rows.removeAll { $0.id == expense.id }
                phase = .ready(rows)
            }
            return nil
        } catch {
            return error.localizedDescription
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
