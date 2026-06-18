import Foundation
import Observation

/// One hit from the `flipdesk_search` RPC (US-1052). Columns mirror the
/// function's `RETURNS TABLE` shape; we only consume `inventory_item_id` to
/// union server matches into the local list, but decode the rest so the DTO
/// stays a faithful mirror.
struct FlipdeskSearchHit: Decodable, Hashable {
    let resultType: String
    let inventoryItemId: String?
    let title: String?
    let rank: Double?

    private enum CodingKeys: String, CodingKey {
        case resultType = "result_type"
        case inventoryItemId = "inventory_item_id"
        case title
        case rank
    }
}

/// Server-side full-text search backed by the Postgres `flipdesk_search`
/// function (US-144 on web, US-1052 on iOS). The iOS inventory list is
/// offline-first, so this is *additive*: it returns the set of
/// `inventory_item_id`s the server matched, which the list unions with its
/// local token search to catch hits on fields the local cache doesn't mirror
/// (notably the server-side `description`). Best-effort — any failure (offline,
/// signed out, RPC error) resolves to an empty set and the local search stands
/// on its own.
@MainActor
@Observable
public final class InventorySearchService {
    /// Most recent server hit-id set for the in-flight query, or nil when no
    /// server search applies (query too short / offline). The list reads this.
    public private(set) var matchedItemIds: Set<String>?

    /// The query the current `matchedItemIds` corresponds to, so a stale
    /// in-flight response can be discarded if the user has typed on.
    private var lastQuery: String = ""

    /// Queries fire only once the term is at least this long — single-character
    /// FTS is noisy and the local substring search already covers it.
    private let minQueryLength = 2

    public init() {}

    /// Runs the server FTS for `query` and publishes the matched item ids.
    /// Trims + length-gates first; a blank/short query clears the server set so
    /// the list falls back to pure local search.
    public func search(_ query: String, limit: Int = 100) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        lastQuery = trimmed
        guard trimmed.count >= minQueryLength else {
            matchedItemIds = nil
            return
        }

        let ids = await Self.fetch(query: trimmed, limit: limit)

        // Drop the result if the user has since changed the query.
        guard trimmed == lastQuery else { return }
        matchedItemIds = ids
    }

    /// Clears any server matches (e.g. when the search field is emptied).
    public func clear() {
        lastQuery = ""
        matchedItemIds = nil
    }

    private nonisolated static func fetch(query: String, limit: Int) async -> Set<String>? {
        struct Params: Encodable {
            let p_query: String
            let p_scope: String
            let p_limit: Int
        }
        do {
            let response = try await SupabaseShared.client
                .rpc(
                    "flipdesk_search",
                    params: Params(p_query: query, p_scope: "items", p_limit: limit)
                )
                .execute()
            let hits = try JSONDecoder().decode([FlipdeskSearchHit].self, from: response.data)
            return Set(hits.compactMap(\.inventoryItemId))
        } catch {
            // Best-effort: offline / signed-out / RPC error → no server hits.
            return nil
        }
    }
}
