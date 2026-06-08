import SwiftData
import SwiftUI

/// Per-consignor payout report (US-676). Computes, from the local cache, how
/// much each consignor is owed across their sold items.
struct ConsignmentReportView: View {
    let store: ConsignorStore

    @Query private var items: [LocalInventoryItem]
    @Query private var sales: [LocalSale]
    @Environment(\.dismiss) private var dismiss

    private var rows: [ConsignmentReportRow] {
        ConsignmentReport.compute(items: items, sales: sales, consignors: store.consignors)
    }

    private var totalOwed: Double { rows.reduce(0) { $0 + $1.consignorPayout } }

    var body: some View {
        List {
            if rows.isEmpty {
                ContentUnavailableView(
                    "No consigned sales yet",
                    systemImage: "chart.bar.doc.horizontal",
                    description: Text("Once items linked to a consignor sell, their payout shows up here.")
                )
            } else {
                Section {
                    LabeledContent("Total owed", value: money(totalOwed))
                        .font(.brandHeadline)
                }
                Section("By consignor") {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(row.consignorName).font(.body.weight(.medium))
                                Spacer()
                                Text(money(row.consignorPayout))
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.green)
                            }
                            HStack(spacing: 8) {
                                Text("\(row.itemsSold) sold")
                                Text("·")
                                Text("\(money(row.grossRevenue)) gross")
                                Text("·")
                                Text("you keep \(money(row.yourCut))")
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .navigationTitle("Payout Report")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }

    private func money(_ value: Double) -> String {
        let code = AppPreferences.currencyCode ?? Locale.current.currency?.identifier ?? "USD"
        return value.formatted(.currency(code: code))
    }
}
