import Foundation
import Supabase

/// Data layer for native Scheduled Drops (US-1127). Reads + writes the
/// `listings` table directly through supabase-swift — every query rides the
/// signed-in user's JWT, so RLS scopes rows to the caller via `inventory_items`
/// ownership (the same path ``ListingDraftService`` / ``FulfillmentService``
/// use). This mirrors the web surface, which also reads `listings` directly
/// rather than through an edge endpoint. Behind a protocol so
/// ``ScheduledDropsStore`` is unit-testable with a fake.
protocol ScheduledDropsProviding {
    /// Every `draft` listing with a scheduled publish time, soonest first.
    func list() async throws -> [ScheduledDrop]
    /// Move a scheduled drop to a new instant.
    func reschedule(listingId: String, to date: Date) async throws
    /// Cancel a scheduled drop (clears `scheduled_publish_at`; the draft stays).
    func cancel(listingId: String) async throws
}

struct ScheduledDropsService: ScheduledDropsProviding {
    private let supabase: SupabaseClient

    init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    private static let selectColumns =
        "id, inventory_item_id, listing_title, listing_price, scheduled_publish_at, " +
        "promo_opt_out, promo_rate_pct, inventory_items(title)"

    func list() async throws -> [ScheduledDrop] {
        let rows: [ScheduledDropRow] = try await supabase
            .from("listings")
            .select(Self.selectColumns)
            .eq("listing_status", value: "draft")
            .not("scheduled_publish_at", operator: .is, value: "null")
            .order("scheduled_publish_at", ascending: true)
            .limit(500)
            .execute()
            .value
        // Defensive: drop any row whose timestamp fails to parse rather than
        // throwing the whole list away.
        return rows.compactMap(ScheduledDrop.init(row:))
    }

    func reschedule(listingId: String, to date: Date) async throws {
        struct Update: Encodable { let scheduled_publish_at: String }
        try await supabase
            .from("listings")
            .update(Update(scheduled_publish_at: ScheduledDropScheduling.isoString(date)))
            .eq("id", value: listingId)
            .execute()
    }

    func cancel(listingId: String) async throws {
        // supabase-swift's synthesized Encodable omits a nil optional
        // (`encodeIfPresent`), which would no-op the update — so encode an
        // explicit JSON null to actually clear the column (US-814 pattern).
        struct Cancel: Encodable {
            enum CodingKeys: String, CodingKey { case scheduled_publish_at }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encodeNil(forKey: .scheduled_publish_at)
            }
        }
        try await supabase
            .from("listings")
            .update(Cancel())
            .eq("id", value: listingId)
            .execute()
    }
}
