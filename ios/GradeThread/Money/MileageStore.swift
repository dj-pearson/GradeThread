import Foundation
import Observation
import SwiftData

/// US-3014 — mileage trips, logged where they happen.
///
/// Same shape as ``ExpenseStore``, deliberately: local mirror FIRST, then the
/// server. A transient failure rides the offline mutation queue; anything else
/// rolls the local row back, so the log never shows a trip the server refused
/// outright and the seller never claims miles nothing will agree with.
///
/// The SERVER table and the local model are both about `mileage_trips` — unlike
/// expenses, where the local model is `LocalExpense` and the table is
/// `flipdesk_expenses`, a mismatch that shows up as a silent 404 the first time
/// somebody assumes they match.
@MainActor
@Observable
final class MileageStore {

    /// Outcome of a write. The three cases exist so the form can say something
    /// TRUE rather than a generic "saved": queued is not saved, and telling a
    /// seller their trip is on the server when it is in a queue is how a
    /// missing deduction gets discovered in April.
    enum WriteResult: Equatable {
        case saved
        case savedOffline
        case failed(String)
    }

    private static let table = "mileage_trips"

    /// Creates or updates a trip.
    ///
    /// `userId` is carried on the row because the INSERT policy's WITH CHECK
    /// requires `auth.uid() = user_id` and the column has no default — the same
    /// reason ``ExpenseStore/create`` carries it.
    func save(
        draft: TripDraft,
        userId: String,
        queueContext: ModelContext
    ) async -> WriteResult {
        if let invalid = draft.invalidReason {
            return .failed(invalid.message)
        }
        guard let miles = draft.miles else {
            return .failed(TripDraft.Invalid.noMiles.message)
        }

        struct Upsert: Encodable {
            let id: String
            let user_id: String
            let trip_date: String
            let miles: Double
            let purpose: String
            // Explicit nulls, never omitted keys. On an edit an omitted key
            // leaves the old value in place, so clearing a location would look
            // like it worked and silently keep the old one.
            let start_location: String?
            let end_location: String?
            let round_trip: Bool
            let source_id: String?
        }

        // Lowercased at the MINT site to match Postgres `uuid` normalization:
        // an UPPERCASE client id misses the case-sensitive sync-merge lookup on
        // pull-back and duplicates the trip. An edit keeps its own id so the
        // upsert replaces rather than adds.
        let id = draft.id ?? UUID().uuidString.lowercased()
        let row = Upsert(
            id: id,
            user_id: userId,
            // A `date` column, so `YYYY-MM-DD` through the one named place.
            // Sending a full timestamp makes Postgres truncate it in UTC, which
            // moves an evening trip to the next day east of Greenwich.
            trip_date: MoneyDate.iso(draft.tripDate),
            miles: miles,
            purpose: draft.purpose.trimmingCharacters(in: .whitespacesAndNewlines),
            start_location: blankToNil(draft.startLocation),
            end_location: blankToNil(draft.endLocation),
            round_trip: draft.roundTrip,
            source_id: draft.sourceId
        )

        let previous = draft.id.flatMap { existing(id: $0, in: queueContext) }
            .map(Snapshot.init)

        mirror(id: id, draft: draft, miles: miles, in: queueContext)

        do {
            try await SupabaseShared.client
                .from(Self.table)
                .upsert(row)
                .execute()
            return .saved
        } catch {
            guard OfflineMutationQueue.shouldQueue(error) else {
                // A validation or RLS rejection is permanent. Keeping the local
                // row would put miles in the seller's deduction that no server
                // will ever accept, so it is rolled back.
                rollback(to: previous, id: id, in: queueContext)
                return .failed(
                    FriendlyErrorCopy.actionMessage(
                        for: error,
                        fallback: "Couldn't save that trip. Please try again."
                    )
                )
            }
            // The SAME lowercase id the mirror uses, so the replay upserts that
            // row rather than minting a second one (US-1494).
            _ = OfflineMutationQueue.enqueueCreate(
                kind: .createMileageTrip, payload: row, id: id, in: queueContext
            )
            return .savedOffline
        }
    }

    func delete(id: String, queueContext: ModelContext) async -> WriteResult {
        let previous = existing(id: id, in: queueContext).map(Snapshot.init)
        removeLocally(id: id, in: queueContext)

        do {
            try await SupabaseShared.client
                .from(Self.table)
                .delete()
                .eq("id", value: id)
                .execute()
            return .saved
        } catch {
            guard OfflineMutationQueue.shouldQueue(error) else {
                rollback(to: previous, id: id, in: queueContext)
                return .failed(
                    FriendlyErrorCopy.actionMessage(
                        for: error,
                        fallback: "Couldn't delete that trip. Please try again."
                    )
                )
            }
            OfflineMutationQueue.enqueueDelete(
                kind: .deleteMileageTrip, targetId: id, in: queueContext
            )
            return .savedOffline
        }
    }

    // MARK: - Local mirror

    /// A plain value copy of a row, taken before it is changed.
    ///
    /// A `@Model` instance is a live reference into the context: holding one and
    /// writing it back after an edit restores nothing, because it changed with
    /// the row. The rollback needs the OLD field values, so they are copied out.
    private struct Snapshot {
        let id: String
        let tripDate: Date
        let miles: Double
        let purpose: String
        let startLocation: String?
        let endLocation: String?
        let roundTrip: Bool
        let sourceId: String?
        let createdAt: Date

        init(_ row: LocalMileageTrip) {
            id = row.id
            tripDate = row.tripDate
            miles = row.miles
            purpose = row.purpose
            startLocation = row.startLocation
            endLocation = row.endLocation
            roundTrip = row.roundTrip
            sourceId = row.sourceId
            createdAt = row.createdAt
        }
    }

    private func existing(id: String, in context: ModelContext) -> LocalMileageTrip? {
        let predicate = #Predicate<LocalMileageTrip> { $0.id == id }
        return try? context.fetch(FetchDescriptor(predicate: predicate)).first
    }

    private func mirror(
        id: String,
        draft: TripDraft,
        miles: Double,
        in context: ModelContext
    ) {
        let purpose = draft.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        if let existingRow = existing(id: id, in: context) {
            existingRow.tripDate = draft.tripDate
            existingRow.miles = miles
            existingRow.purpose = purpose
            existingRow.startLocation = blankToNil(draft.startLocation)
            existingRow.endLocation = blankToNil(draft.endLocation)
            existingRow.roundTrip = draft.roundTrip
            existingRow.sourceId = draft.sourceId
        } else {
            context.insert(
                LocalMileageTrip(
                    id: id,
                    tripDate: draft.tripDate,
                    miles: miles,
                    purpose: purpose,
                    startLocation: blankToNil(draft.startLocation),
                    endLocation: blankToNil(draft.endLocation),
                    roundTrip: draft.roundTrip,
                    sourceId: draft.sourceId
                )
            )
        }
        context.saveOrLog("mirrorTrip")
    }

    private func rollback(to previous: Snapshot?, id: String, in context: ModelContext) {
        guard let previous else {
            removeLocally(id: id, in: context)
            return
        }
        if let row = existing(id: previous.id, in: context) {
            row.tripDate = previous.tripDate
            row.miles = previous.miles
            row.purpose = previous.purpose
            row.startLocation = previous.startLocation
            row.endLocation = previous.endLocation
            row.roundTrip = previous.roundTrip
            row.sourceId = previous.sourceId
        } else {
            context.insert(
                LocalMileageTrip(
                    id: previous.id,
                    tripDate: previous.tripDate,
                    miles: previous.miles,
                    purpose: previous.purpose,
                    startLocation: previous.startLocation,
                    endLocation: previous.endLocation,
                    roundTrip: previous.roundTrip,
                    sourceId: previous.sourceId,
                    createdAt: previous.createdAt
                )
            )
        }
        context.saveOrLog("rollbackTrip")
    }

    private func removeLocally(id: String, in context: ModelContext) {
        guard let row = existing(id: id, in: context) else { return }
        context.delete(row)
        context.saveOrLog("removeTrip")
    }

    private func blankToNil(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Totals over a set of trips.
///
/// DELIBERATELY NOT A DEDUCTION. The rate is a dated table on the server
/// (migration 00695: it has changed mid-year before, and 2026's is provisional),
/// so working a dollar figure out on the phone would be a second answer to a
/// question the server already answers — and the wrong one on the day a rate is
/// corrected. The app shows miles and points at the web summary for the money.
enum MileageTotals {

    /// Miles in one calendar year, rounded to a tenth PER TRIP.
    ///
    /// Per trip, not on the total, because that is what both the server summary
    /// and the packet do. Summing full-precision values and rounding once at the
    /// end gives a different figure, and two figures for the same drives is the
    /// thing the whole books epic exists to prevent.
    static func miles(in trips: [LocalMileageTrip], year: Int) -> Double {
        let tenths = trips
            .filter { MoneyDate.year(of: $0.tripDate) == year }
            .reduce(0) { $0 + Int(($1.miles * 10).rounded()) }
        return Double(tenths) / 10.0
    }

    static func tripCount(in trips: [LocalMileageTrip], year: Int) -> Int {
        trips.filter { MoneyDate.year(of: $0.tripDate) == year }.count
    }
}
