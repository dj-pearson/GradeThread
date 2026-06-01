import Foundation
import Observation

/// Fetches the signed-in user's sales (RLS-scoped through `inventory_items`
/// ownership) for the Sales tab. Read-only for now — order/payout
/// reconciliation is the heavier follow-up (US-184).
@MainActor
@Observable
public final class SalesStore {
    public enum Phase: Equatable {
        case loading
        case ready(sales: [RemoteSale])
        case failed(message: String)
    }

    public var phase: Phase = .loading

    public var sales: [RemoteSale] {
        if case let .ready(sales) = phase { return sales }
        return []
    }

    /// Running total of net proceeds (price − fees) across all loaded sales.
    public var totalNet: Double { sales.reduce(0) { $0 + $1.net } }

    public func refresh() async {
        phase = .loading
        do {
            // RLS on `sales` scopes to the caller via inventory-item ownership;
            // the `inventory_items(title)` embed rides the same policy. Decode
            // raw bytes per-row so one malformed sale can't blank the list.
            let response = try await SupabaseShared.client
                .from("sales")
                .select("id, sale_price, platform_fees, sale_date, buyer_username, inventory_items(title)")
                .order("sale_date", ascending: false)
                .limit(500)
                .execute()
            phase = .ready(sales: Self.decodeSalesResiliently(response.data))
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    static func decodeSalesResiliently(_ data: Data) -> [RemoteSale] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteSale>].self, from: data
        ) else { return [] }
        return rows.compactMap(\.value)
    }

    /// Decodes to nil instead of throwing, so one bad row can't abort the array.
    private struct Failable<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws {
            value = try? decoder.singleValueContainer().decode(T.self)
        }
    }
}
