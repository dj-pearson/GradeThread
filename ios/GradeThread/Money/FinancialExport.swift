import Foundation
import SwiftData
import SwiftUI
import UIKit

/// US-664 — pure financial-report CSV builder. Mirrors the web
/// `src/components/finances/financial-export.tsx` structure (a summary block +
/// transaction details) but sourced from the local SwiftData cache so it works
/// offline. Pure + value-typed so the math is unit-testable without any view.
enum FinancialExport {

    struct Transaction: Equatable {
        let date: Date
        let itemTitle: String
        let salePrice: Double
        let fees: Double
        let cogs: Double
        var net: Double { salePrice - fees - cogs }
    }

    struct Summary: Equatable {
        let grossRevenue: Double
        let platformFees: Double
        let cogs: Double
        var netProfit: Double { grossRevenue - platformFees - cogs }
    }

    /// Sales whose `saleDate` falls within [start, end], joined to their item
    /// for COGS (the item's acquired price), newest first.
    static func transactions(
        sales: [LocalSale],
        items: [LocalInventoryItem],
        start: Date,
        end: Date
    ) -> [Transaction] {
        let itemsById = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return sales
            .filter { $0.saleDate >= start && $0.saleDate <= end }
            .sorted { $0.saleDate > $1.saleDate }
            .map { sale in
                let item = itemsById[sale.inventoryItemId]
                return Transaction(
                    date: sale.saleDate,
                    itemTitle: item?.title ?? "—",
                    salePrice: sale.salePrice,
                    fees: sale.platformFees,
                    cogs: item?.acquiredPrice ?? 0
                )
            }
    }

    static func summary(_ transactions: [Transaction]) -> Summary {
        Summary(
            grossRevenue: transactions.reduce(0) { $0 + $1.salePrice },
            platformFees: transactions.reduce(0) { $0 + $1.fees },
            cogs: transactions.reduce(0) { $0 + $1.cogs }
        )
    }

    static func csv(
        sales: [LocalSale],
        items: [LocalInventoryItem],
        start: Date,
        end: Date
    ) -> String {
        let txns = transactions(sales: sales, items: items, start: start, end: end)
        let totals = summary(txns)
        let df = ISO8601DateFormatter()
        df.formatOptions = [.withFullDate]

        var lines: [String] = []
        lines.append("GradeThread Financial Report")
        lines.append("Period,\(df.string(from: start)) to \(df.string(from: end))")
        lines.append("")
        lines.append("SUMMARY")
        lines.append("Gross Revenue,\(money(totals.grossRevenue))")
        lines.append("Platform Fees,\(money(totals.platformFees))")
        lines.append("Cost of Goods (COGS),\(money(totals.cogs))")
        lines.append("Net Profit,\(money(totals.netProfit))")
        lines.append("")
        lines.append("TRANSACTION DETAILS")
        lines.append("Date,Item,Sale Price,Fees,COGS,Net")
        for t in txns {
            lines.append([
                df.string(from: t.date),
                escape(t.itemTitle),
                money(t.salePrice),
                money(t.fees),
                money(t.cogs),
                money(t.net),
            ].joined(separator: ","))
        }
        return lines.joined(separator: "\n")
    }

    static func filename(start: Date, end: Date) -> String {
        let df = ISO8601DateFormatter()
        df.formatOptions = [.withFullDate]
        return "gradethread_financial_report_\(df.string(from: start))_\(df.string(from: end)).csv"
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

    @State private var startDate: Date = Calendar.current.date(byAdding: .day, value: -90, to: .now) ?? .now
    @State private var endDate: Date = .now
    @State private var exportURL: ExportURL?

    private var transactionCount: Int {
        FinancialExport.transactions(sales: sales, items: items, start: startOfDay(startDate), end: endOfDay(endDate)).count
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Date range") {
                    DatePicker("From", selection: $startDate, displayedComponents: .date)
                    DatePicker("To", selection: $endDate, displayedComponents: .date)
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
        let start = startOfDay(startDate)
        let end = endOfDay(endDate)
        let csv = FinancialExport.csv(sales: sales, items: items, start: start, end: end)
        // US-694: write the financial CSV with file protection into the swept
        // Exports/ subdirectory instead of bare-.atomic into tmp.
        guard let data = csv.data(using: .utf8),
              let url = try? SecureTempFile.write(data, filename: FinancialExport.filename(start: start, end: end))
        else { return }
        exportURL = ExportURL(url: url)
        HapticFeedback.success()
    }

    private func startOfDay(_ date: Date) -> Date { Calendar.current.startOfDay(for: date) }
    private func endOfDay(_ date: Date) -> Date {
        Calendar.current.date(bySettingHour: 23, minute: 59, second: 59, of: date) ?? date
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
