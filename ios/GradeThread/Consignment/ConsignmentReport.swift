import Foundation
import GradeThreadCore

/// One consignor's payout summary over the reported sales (US-676).
struct ConsignmentReportRow: Identifiable, Equatable {
    let consignorId: String
    let consignorName: String
    var itemsSold: Int
    var grossRevenue: Double
    var fees: Double
    /// gross − fees.
    var netProceeds: Double
    /// Amount owed to the consignor (their split of net proceeds).
    var consignorPayout: Double
    /// What the reseller keeps (netProceeds − consignorPayout).
    var yourCut: Double

    var id: String { consignorId }
}

/// Pure per-consignor payout rollup. Net proceeds = sale price − platform fees;
/// the consignor is owed `split%` of that (per-item override, else the
/// consignor's default split); the reseller keeps the remainder. Consignment
/// items are typically acquired at $0 COGS, so COGS is intentionally excluded.
enum ConsignmentReport {

    /// A sold, consigned item flattened to just the numbers the rollup needs —
    /// keeps `compute` independent of SwiftData so it's unit-testable.
    struct SoldConsignedItem: Equatable {
        let consignorId: String
        let splitPctOverride: Double?
        let salePrice: Double
        let fees: Double
    }

    static func compute(
        soldItems: [SoldConsignedItem],
        consignors: [Consignor]
    ) -> [ConsignmentReportRow] {
        let byId = Dictionary(uniqueKeysWithValues: consignors.map { ($0.id, $0) })
        var rows: [String: ConsignmentReportRow] = [:]

        for item in soldItems {
            guard let consignor = byId[item.consignorId] else { continue }
            let split = clampPct(item.splitPctOverride ?? consignor.defaultSplitPct)
            // Round each line item to whole cents (Money.cents): consignorPayout is
            // money OWED to a third party, so `$10.05 × 33.33%` must not carry
            // fractional-cent noise into the payable, and the per-consignor totals
            // must foot against a Money-summed equivalent to the cent.
            let net = Money.cents(item.salePrice - item.fees)
            // Don't pay out on a loss — clamp the consignor's owed amount at 0
            // for a net-negative sale (rare, but a refund-heavy row shouldn't
            // produce a negative "owed").
            let payout = Money.cents(max(net, 0) * split / 100.0)

            var row = rows[item.consignorId] ?? ConsignmentReportRow(
                consignorId: consignor.id,
                consignorName: consignor.name,
                itemsSold: 0,
                grossRevenue: 0,
                fees: 0,
                netProceeds: 0,
                consignorPayout: 0,
                yourCut: 0
            )
            row.itemsSold += 1
            row.grossRevenue += item.salePrice
            row.fees += item.fees
            row.netProceeds += net
            row.consignorPayout += payout
            row.yourCut += net - payout
            rows[item.consignorId] = row
        }

        // Most owed first — that's the actionable order (who to pay).
        return rows.values.sorted { $0.consignorPayout > $1.consignorPayout }
    }

    /// Convenience over the local cache: joins sales to their items, keeps only
    /// consigned items, and runs the pure rollup.
    ///
    /// Cancelled/refunded sales are excluded (via `SalePnL.isCompleted`) so a
    /// reversed sale doesn't generate a payout the reseller never collected, and
    /// the fee total mirrors `SalePnL.fees` (platform + payment-processing) so
    /// net proceeds — and therefore the consignor's owed amount — aren't
    /// overstated.
    static func compute(
        items: [LocalInventoryItem],
        sales: [LocalSale],
        consignors: [Consignor]
    ) -> [ConsignmentReportRow] {
        let itemsById = Dictionary(items.map { ($0.id, $0) }) { a, _ in a }
        let sold: [SoldConsignedItem] = sales.compactMap { sale in
            guard SalePnL.isCompleted(sale),
                  let item = itemsById[sale.inventoryItemId],
                  let consignorId = item.consignorId else { return nil }
            return SoldConsignedItem(
                consignorId: consignorId,
                splitPctOverride: item.consignmentSplitPct,
                salePrice: sale.salePrice,
                fees: SalePnL.fees(sale)
            )
        }
        return compute(soldItems: sold, consignors: consignors)
    }

    static func clampPct(_ p: Double) -> Double { min(max(p, 0), 100) }
}
