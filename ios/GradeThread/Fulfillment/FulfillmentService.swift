import Foundation

/// Data layer for the shipping/fulfillment queue (US-669). Reads + writes the
/// `sales` table directly through supabase-swift — every query rides the
/// signed-in user's JWT, so RLS scopes rows to the caller via `inventory_items`
/// ownership (the same path ``SalesStore`` uses). Behind a protocol so
/// ``FulfillmentStore`` is unit-testable with a fake.
protocol FulfillmentProviding {
    /// Fetches recent sold orders with their shipping fields + item title. The
    /// store filters to the unshipped subset; fetching the recent window keeps
    /// the query simple and matches ``SalesStore``'s read shape.
    func fetchOrders() async throws -> [FulfillmentOrder]

    /// Marks a sale shipped: stamps `shipped_at` and, when provided, the
    /// `tracking_number`. An empty/nil tracking number is omitted from the
    /// update so an existing tracking value is never clobbered.
    func markShipped(saleId: String, trackingNumber: String?, shippedAt: Date) async throws
}

struct FulfillmentService: FulfillmentProviding {
    func fetchOrders() async throws -> [FulfillmentOrder] {
        // RLS on `sales` scopes to the caller via inventory-item ownership; the
        // `inventory_items(title)` embed rides the same policy. Newest first so
        // unshipped orders (which are recent by nature) land in the window.
        let response = try await SupabaseShared.client
            .from("sales")
            .select(
                "id, sale_price, shipping_cost, sale_date, sold_at, shipped_at, tracking_number, buyer_username, inventory_items(title)"
            )
            .order("sale_date", ascending: false)
            .limit(500)
            .execute()
        return FulfillmentStore.decodeOrdersResiliently(response.data)
    }

    func markShipped(saleId: String, trackingNumber: String?, shippedAt: Date) async throws {
        // timestamptz accepts an ISO 8601 instant.
        let iso = ISO8601DateFormatter().string(from: shippedAt)

        // US-1039: for an eBay order (platform_order_id set) WITH a tracking
        // number, push the tracking to eBay via the edge — which also records
        // shipped_at + tracking_number server-side (so we don't double-write).
        // eBay's shipping_fulfillment requires a tracking number, so without one
        // we fall through to the local-only write below (manual/other sales too).
        if let tracking = trackingNumber, !tracking.isEmpty {
            let response = try await SupabaseShared.client
                .from("sales")
                .select("platform_order_id")
                .eq("id", value: saleId)
                .limit(1)
                .execute()
            struct OrderRef: Decodable { let platform_order_id: String? }
            let refs = (try? JSONDecoder().decode([OrderRef].self, from: response.data)) ?? []
            if let oid = refs.first?.platform_order_id, !oid.isEmpty {
                struct ShipBody: Encodable {
                    let tracking_number: String
                    let carrier: String?
                }
                struct OKResponse: Decodable { let ok: Bool? }
                let result: OKResponse = try await EdgeAPI.shared.postJSON(
                    "/api/flipdesk/ebay/orders/\(saleId)/ship",
                    body: ShipBody(tracking_number: tracking, carrier: nil)
                )
                // US-1271: a 200 with an empty body or {ok:false} is NOT a
                // successful fulfillment — don't optimistically mark it shipped.
                guard result.ok == true else {
                    throw EdgeAPIError.serverError(
                        detail: "eBay didn't confirm the shipment. Check Marketplaces and try again."
                    )
                }
                return
            }
        }

        // Local-only write: manual/other-marketplace sales, or no tracking yet.
        // Scoped by id under RLS — the user can only update their own sale rows
        // (ownership flows through inventory_items), mirroring ReconciliationService.
        let builder = SupabaseShared.client.from("sales")
        if let tracking = trackingNumber, !tracking.isEmpty {
            struct Update: Encodable {
                let shipped_at: String
                let tracking_number: String
            }
            try await builder
                .update(Update(shipped_at: iso, tracking_number: tracking))
                .eq("id", value: saleId)
                .execute()
        } else {
            // Omit tracking_number entirely so we don't null out an existing value.
            struct Update: Encodable { let shipped_at: String }
            try await builder
                .update(Update(shipped_at: iso))
                .eq("id", value: saleId)
                .execute()
        }
    }
}
