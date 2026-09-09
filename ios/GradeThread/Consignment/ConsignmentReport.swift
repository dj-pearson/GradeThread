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

        /// One sold item's cents-exact line, so the per-consignor totals can be
        /// summed rather than accumulated.
        struct Line {
            let gross: Double
            let fees: Double
            let net: Double
            let payout: Double
            var yourCut: Double { net - payout }
        }

        let lines: [(consignorId: String, line: Line)] = soldItems.compactMap { item in
            guard let consignor = byId[item.consignorId] else { return nil }
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
            return (
                item.consignorId,
                Line(gross: item.salePrice, fees: item.fees, net: net, payout: payout)
            )
        }

        // US-3234: totalled with `Money.sum`, not accumulated with `+=`. The
        // comment above has always said these must foot against a Money-summed
        // equivalent to the cent, and a running `Double` does not — on a
        // consignor with a few hundred sales the payable could differ from the
        // screen's own total, and this is money owed to somebody else.
        return Dictionary(grouping: lines, by: { $0.consignorId })
            .compactMap { consignorId, group -> ConsignmentReportRow? in
                guard let consignor = byId[consignorId] else { return nil }
                let items = group.map(\.line)
                return ConsignmentReportRow(
                    consignorId: consignor.id,
                    consignorName: consignor.name,
                    itemsSold: items.count,
                    grossRevenue: Money.sum(items) { $0.gross },
                    fees: Money.sum(items) { $0.fees },
                    netProceeds: Money.sum(items) { $0.net },
                    consignorPayout: Money.sum(items) { $0.payout },
                    yourCut: Money.sum(items) { $0.yourCut }
                )
            }
            // Most owed first — that's the actionable order (who to pay). Name
            // breaks a tie so the order is stable rather than whatever the
            // dictionary iterated this time.
            .sorted { lhs, rhs in
                if lhs.consignorPayout != rhs.consignorPayout {
                    return lhs.consignorPayout > rhs.consignorPayout
                }
                return lhs.consignorName < rhs.consignorName
            }
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
