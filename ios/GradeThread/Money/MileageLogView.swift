import SwiftData
import SwiftUI

/// US-3014 — the mileage log.
///
/// Reads the local mirror, not the server, so it is the same list with or
/// without signal. That is not a nicety: the screen a seller checks to see
/// whether they already logged today's drive has to work in the car park where
/// they logged it.
///
/// IT SHOWS MILES, NOT DOLLARS, and that is deliberate. The rate is a dated
/// table on the server (migration 00695: it has changed mid-year before, and
/// 2026's is carried forward and provisional). Working a deduction out on the
/// phone would be a second answer to a question the server already answers, and
/// the wrong one on the day a rate is corrected. The web summary owns the money.
struct MileageLogView: View {
    @Environment(\.modelContext) private var modelContext

    @Query(sort: \LocalMileageTrip.tripDate, order: .reverse)
    private var trips: [LocalMileageTrip]

    @State private var store = MileageStore()
    @State private var showingForm = false
    @State private var deleting: String?

    private var year: Int { MoneyDate.year(of: MoneyDate.today()) }

    private var milesThisYear: Double {
        MileageTotals.miles(in: trips, year: year)
    }

    private var tripsThisYear: Int {
        MileageTotals.tripCount(in: trips, year: year)
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(milesFormatted(milesThisYear))
                        .font(.largeTitle.weight(.semibold))
                        .monospacedDigit()
                    Text("business miles in \(String(year)), over \(tripsThisYear) trip\(tripsThisYear == 1 ? "" : "s")")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("What that is worth depends on the year's published rate, which we keep on the server. Open Money on the web to see the deduction and answer the Part IV vehicle questions.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.top, 2)
                }
                .padding(.vertical, 4)
            }

            if trips.isEmpty {
                Section {
                    Text("No trips yet. Log the next one as you get back in the car — that is the record the IRS accepts, and it takes about ten seconds.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section("Trips") {
                    ForEach(trips) { trip in
                        TripRow(trip: trip)
                    }
                    .onDelete { offsets in
                        Task { await delete(at: offsets) }
                    }
                }
            }
        }
        .navigationTitle("Mileage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showingForm = true
                } label: {
                    Label("Log a trip", systemImage: "plus")
                }
            }
        }
        // ONE sheet on this view. Two `.sheet` modifiers compete for a single
        // slot and the loser opens and closes in the same frame
        // (ios/Scripts/check-chained-sheets.py).
        .sheet(isPresented: $showingForm) {
            TripFormSheet(store: store)
        }
    }

    private func milesFormatted(_ miles: Double) -> String {
        String(format: "%.1f", miles)
    }

    private func delete(at offsets: IndexSet) async {
        for index in offsets {
            guard index < trips.count else { continue }
            let id = trips[index].id
            deleting = id
            _ = await store.delete(id: id, queueContext: modelContext)
            deleting = nil
        }
    }
}

private struct TripRow: View {
    let trip: LocalMileageTrip

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(TripDraft.displayPurpose(trip.purpose))
                    .font(.body)
                Spacer()
                Text(String(format: "%.1f mi", trip.miles))
                    .font(.body.weight(.medium))
                    .monospacedDigit()
            }
            HStack(spacing: 6) {
                Text(MoneyDate.iso(trip.tripDate))
                if let route = route {
                    Text(route)
                }
                if trip.roundTrip {
                    Text("round trip")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var route: String? {
        switch (trip.startLocation, trip.endLocation) {
        case let (start?, end?): return "\(start) to \(end)"
        case let (start?, nil): return "from \(start)"
        case let (nil, end?): return "to \(end)"
        default: return nil
        }
    }
}
