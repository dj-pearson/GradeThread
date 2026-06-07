import Foundation
import Observation

/// Drives the shipping/fulfillment queue (US-669): loads sold-but-unshipped
/// orders, ranks them oldest-first (ship-by priority), and marks them shipped.
/// Mirrors ``PayoutReconciliationStore``'s phase + optimistic-action shape.
@MainActor
@Observable
final class FulfillmentStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: FulfillmentProviding

    var phase: Phase = .loading
    /// Needs-shipping queue (unshipped), oldest sold first.
    private(set) var orders: [FulfillmentOrder] = []
    /// Surfaced when a mark-shipped write fails; the view shows it in an alert.
    var actionError: String?

    init(service: FulfillmentProviding = FulfillmentService()) {
        self.service = service
    }

    /// Count of orders awaiting shipment.
    var needsShippingCount: Int { orders.count }

    /// Total outstanding shipping-label cost across the queue. Surfaces the
    /// daily ship cost that already feeds item P&L.
    var totalLabelCost: Double { orders.reduce(0) { $0 + $1.shippingCost } }

    func load() async {
        phase = .loading
        do {
            let all = try await service.fetchOrders()
            orders = all
                .filter { !$0.isShipped }
                .sorted { $0.soldDate < $1.soldDate }
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    /// Optimistically removes the order from the queue, then persists. On
    /// failure it reloads to restore truth and surfaces the error. On success
    /// it nudges the sync engine so the local cache + widgets catch up.
    func markShipped(_ order: FulfillmentOrder, trackingNumber: String?) async {
        let trimmed = trackingNumber?.trimmingCharacters(in: .whitespacesAndNewlines)
        let tracking = (trimmed?.isEmpty == false) ? trimmed : nil
        orders.removeAll { $0.id == order.id }
        do {
            try await service.markShipped(
                saleId: order.id,
                trackingNumber: tracking,
                shippedAt: .now
            )
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        } catch {
            actionError = error.localizedDescription
            // Re-pull so the optimistically-removed row reappears if it really
            // didn't ship.
            await load()
        }
    }

    static func decodeOrdersResiliently(_ data: Data) -> [FulfillmentOrder] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<FulfillmentOrder>].self, from: data
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
