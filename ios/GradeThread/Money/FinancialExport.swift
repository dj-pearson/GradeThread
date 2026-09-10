import Foundation
import GradeThreadCore
import SwiftData
import SwiftUI
import UIKit

/// US-664 — pure financial-report CSV builder. Mirrors the web
/// `src/components/finances/financial-export.tsx` structure (a summary block +
/// transaction details) but sourced from the local SwiftData cache so it works
/// offline. Pure + value-typed so the math is unit-testable without any view.
enum FinancialExport {

    /// US-1194: the per-line components mirror ``SalePnL`` exactly so the export
    /// foots to the same net the Money tab and Profit-by-item show. `grossRevenue`
    /// folds in shipping collected; `fees` folds in payment-processing fees;
    /// `sellerCosts` covers shipping/grading/other costs; `cogs` is the cost basis.
    struct Transaction: Equatable {
        let date: Date
        let itemTitle: String
        let grossRevenue: Double
        let fees: Double
        let sellerCosts: Double
        let cogs: Double
        var net: Double { grossRevenue - fees - sellerCosts - cogs }
    }

    struct Summary: Equatable {
        let grossRevenue: Double
        let platformFees: Double
        let sellerCosts: Double
        let cogs: Double
        var netProfit: Double { grossRevenue - platformFees - sellerCosts - cogs }
    }

    /// The instants a picked range of sale days covers, half-open.
    ///
    /// US-3231 - THE INTERLEAVING, which is invisible from either side alone.
    ///
    /// Every writer of `sales.sale_date` sends a date-only `YYYY-MM-DD`. iOS
    /// `SaleRecorder` formats the picked day with a zone-less `DateFormatter`
    /// (so, the device's own calendar day), the web record-sale dialog uses an
    /// `<input type="date">`, and the Depop/Etsy/Shopify/eBay importers slice
    /// the first ten characters off `sold_at`. The column is declared
    /// `timestamptz` (00002_inventory_financial.sql:71), so Postgres widens
    /// that day to MIDNIGHT UTC, and `finances_export`
    /// (00143_finances_dashboard.sql:548) reads it back as `sale_date::date`
    /// in a UTC session. A stored sale day is a UTC-midnight anchor, not a
    /// moment - which is why the column type alone is misleading here.
    ///
    /// The sheet used to bound the range with `Calendar.current.startOfDay`
    /// and a local 23:59:59, so both ends slid by the device's offset from
    /// UTC. For a seller in Chicago (UTC-5) a 1-30 September range actually
    /// ran 1 Sep 05:00Z to 1 Oct 04:59:59Z: it dropped every sale dated
    /// 1 September (anchored five hours before the start bound) and quietly
    /// swept in 1 October's (anchored inside the tail). East of UTC the same
    /// arithmetic runs the other way. Nothing warns; the CSV is simply short
    /// one day's rows and long another's, on a file people file taxes with.
    ///
    /// `end` is EXCLUSIVE and one whole day past `endDay`, so the last day is
    /// covered end to end. The old bound stopped at 23:59:59 and dropped
    /// anything in that final second.
    struct DayBounds: Equatable {
        /// First instant covered - UTC midnight of the first day.
        let start: Date
        /// First instant NOT covered - UTC midnight of the day after the last.
        let end: Date
        /// UTC midnight of the last day covered, for the header and filename.
        let lastDay: Date
    }

    /// Builds ``DayBounds`` from two UTC-anchored days (what
    /// `MoneyDate.dayPicker` hands back). A reversed range collapses onto the
    /// start day rather than producing an empty or negative one.
    static func dayBounds(startDay: Date, endDay: Date) -> DayBounds {
        let start = MoneyDate.startOfDay(startDay)
        let lastDay = max(MoneyDate.startOfDay(endDay), start)
        let end = MoneyDate.calendar.date(byAdding: .day, value: 1, to: lastDay) ?? lastDay
        return DayBounds(start: start, end: end, lastDay: lastDay)
    }

    /// Sales whose `saleDate` falls in `[from, until)`, joined to their item
    /// for COGS (the item's acquired price), newest first.
    ///
    /// US-3231: `until` is EXCLUSIVE. Build both ends with
    /// ``dayBounds(startDay:endDay:)`` rather than by hand - the labels were
    /// renamed from `start:end:` so every existing call site had to be
    /// revisited when the inclusivity changed.
    static func transactions(
        sales: [LocalSale],
        items: [LocalInventoryItem],
        from: Date,
        until: Date
    ) -> [Transaction] {
        let itemsById = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return sales
            .filter { $0.saleDate >= from && $0.saleDate < until }
            .sorted { $0.saleDate > $1.saleDate }
            .map { sale in
                let item = itemsById[sale.inventoryItemId]
                // US-1194: source every component from SalePnL (the single
                // source of truth) so the CSV agrees with the rest of the app.
                return Transaction(
                    date: sale.saleDate,
                    itemTitle: item?.title ?? "—",
                    grossRevenue: SalePnL.revenue(sale),
                    fees: SalePnL.fees(sale),
                    sellerCosts: SalePnL.sellerCosts(sale),
                    cogs: item?.acquiredPrice ?? 0
                )
            }
    }

    static func summary(_ transactions: [Transaction]) -> Summary {
        // US-790: exact-Decimal sums — a financial export must foot to the cent.
        Summary(
            grossRevenue: Money.sum(transactions) { $0.grossRevenue },
            platformFees: Money.sum(transactions) { $0.fees },
            sellerCosts: Money.sum(transactions) { $0.sellerCosts },
            cogs: Money.sum(transactions) { $0.cogs }
        )
    }

    /// The date column, the period header and the filename all print through
    /// ``MoneyDate/iso(_:)``, which is UTC.
    ///
    /// HISTORY, because this reverses an earlier fix and the earlier fix's
    /// reasoning still reads convincingly. This started as a bare
    /// `ISO8601DateFormatter()`; it was then changed to a `Calendar.current`
    /// formatter on the grounds that a sale at 8pm on 31 January in Chicago
    /// must not print as `2026-02-01`. That is the right SYMPTOM and the wrong
    /// CAUSE. A stored `sale_date` is not the moment of the sale, it is the
    /// seller's own calendar day already anchored at UTC midnight (see
    /// ``dayBounds(startDay:endDay:)``). So the round trip is: the seller picks
    /// 31 January, `SaleRecorder` sends `2026-01-31`, Postgres stores
    /// `2026-01-31T00:00Z`, and rendering THAT instant in America/Chicago says
    /// `2026-01-30`. The local formatter lost a day for every seller west of
    /// UTC on every row, and disagreed with `finances_export`, which reports
    /// the same row under `sale_date::date` in UTC. One zone, everywhere, and
    /// it is the one the day was anchored in.
    ///
    /// The rare genuine-moment row (only `flipdesk-import` writes one, from a
    /// CSV `sold_at`) prints its UTC day, which is exactly the day the server
    /// buckets it under. Agreeing with the server is the invariant that
    /// matters on a document an accountant reconciles.
    static func csv(
        sales: [LocalSale],
        items: [LocalInventoryItem],
        startDay: Date,
        endDay: Date
    ) -> String {
        let bounds = dayBounds(startDay: startDay, endDay: endDay)
        let txns = transactions(sales: sales, items: items, from: bounds.start, until: bounds.end)
        let totals = summary(txns)

        var lines: [String] = []
        lines.append("GradeThread Financial Report")
        lines.append("Period,\(MoneyDate.iso(bounds.start)) to \(MoneyDate.iso(bounds.lastDay))")
        lines.append("")
        lines.append("SUMMARY")
        lines.append("Gross Revenue,\(money(totals.grossRevenue))")
        lines.append("Fees,\(money(totals.platformFees))")
        lines.append("Seller Costs,\(money(totals.sellerCosts))")
        lines.append("Cost of Goods (COGS),\(money(totals.cogs))")
        lines.append("Net Profit,\(money(totals.netProfit))")
        lines.append("")
        lines.append("TRANSACTION DETAILS")
        lines.append("Date,Item,Gross Revenue,Fees,Seller Costs,COGS,Net")
        for t in txns {
            lines.append([
                MoneyDate.iso(t.date),
                escape(t.itemTitle),
                money(t.grossRevenue),
                money(t.fees),
                money(t.sellerCosts),
                money(t.cogs),
                money(t.net),
            ].joined(separator: ","))
        }
        return lines.joined(separator: "\n")
    }

    static func filename(startDay: Date, endDay: Date) -> String {
        let bounds = dayBounds(startDay: startDay, endDay: endDay)
        let first = MoneyDate.iso(bounds.start)
        let last = MoneyDate.iso(bounds.lastDay)
        return "gradethread_financial_report_\(first)_\(last).csv"
    }

    private static func money(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    /// Quotes a field that contains a comma/quote/newline (RFC 4180).
    private static func escape(_ field: String) -> String {
        guard field.contains(",") || field.contains("\"") || field.contains("\n") else { return field }
        return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}

// MARK: - Export sheet (US-664)

/// Date-ranged financial export. Reads the local sales + items cache, builds the
/// CSV via ``FinancialExport``, and hands it to the iOS share sheet.
struct FinancialExportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Query private var sales: [LocalSale]
    @Query private var items: [LocalInventoryItem]

    // US-3231: these hold UTC-ANCHORED days, the same shape a stored
    // `sale_date` is, so the range and the rows are expressed in one anchoring.
    // Seeding them with a bare `.now` would put a local moment in a variable
    // everything downstream reads as an anchored day, which is the bug this
    // story fixed.
    @State private var startDate: Date = MoneyDate.anchor(
        localDayOf: Calendar.current.date(byAdding: .day, value: -90, to: .now) ?? .now
    )
    @State private var endDate: Date = MoneyDate.today()
    @State private var exportURL: ExportURL?

    private var transactionCount: Int {
        let bounds = FinancialExport.dayBounds(startDay: startDate, endDay: endDate)
        return FinancialExport.transactions(
            sales: sales,
            items: items,
            from: bounds.start,
            until: bounds.end
        ).count
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Date range") {
                    // US-3231 AC1: bound through MoneyDate.dayPicker, so the
                    // day rendered in the picker (local) and the day the filter
                    // uses (UTC-anchored) are the same day.
                    DatePicker(
                        "From",
                        selection: MoneyDate.dayPicker($startDate),
                        displayedComponents: .date
                    )
                    DatePicker(
                        "To",
                        selection: MoneyDate.dayPicker($endDate),
                        displayedComponents: .date
                    )
                }
                Section {
                    LabeledContent("Transactions", value: "\(transactionCount)")
                } footer: {
                    Text("Exports a transaction-level CSV (sales, fees, COGS, net) plus a summary for the selected range. Reads your local cache, so it works offline.")
                }
                Section {
                    Button {
                        export()
                    } label: {
                        Label("Export CSV", systemImage: "square.and.arrow.up")
                    }
                    .disabled(transactionCount == 0)
                }
            }
            .navigationTitle("Financial export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $exportURL) { wrapper in
                // US-694: delete the protected temp file once the share sheet
                // hands it off, so financial exports don't accumulate in tmp.
                ShareSheet(items: [wrapper.url]) { SecureTempFile.delete(wrapper.url) }
            }
        }
    }

    private func export() {
        let csv = FinancialExport.csv(
            sales: sales,
            items: items,
            startDay: startDate,
            endDay: endDate
        )
        let name = FinancialExport.filename(startDay: startDate, endDay: endDate)
        // US-694: write the financial CSV with file protection into the swept
        // Exports/ subdirectory instead of bare-.atomic into tmp.
        guard let data = csv.data(using: .utf8),
              let url = try? SecureTempFile.write(data, filename: name)
        else { return }
        exportURL = ExportURL(url: url)
        HapticFeedback.success()
    }

    private struct ExportURL: Identifiable { let id = UUID(); let url: URL }

    private struct ShareSheet: UIViewControllerRepresentable {
        let items: [Any]
        var onComplete: (() -> Void)?
        func makeUIViewController(context: Context) -> UIActivityViewController {
            let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
            controller.completionWithItemsHandler = { _, _, _, _ in onComplete?() }
            return controller
        }
        func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
    }
}
