import Foundation
import SwiftData

/// Local mirror of `mileage_trips` (US-3014, migration 00695).
///
/// OFFLINE IS THE WHOLE POINT, not a nicety. A trip is logged in a car park
/// with one bar of signal, and "I had no signal" is the most common reason a
/// seller never goes back and enters it. A log filled in three weeks later is
/// the reconstructed record the IRS specifically discounts, so a trip that only
/// exists when the network does is a deduction that mostly does not get claimed.
///
/// `tripDate` anchors a CALENDAR DAY at UTC midnight through ``MoneyDate`` —
/// the server column is `date`, and every bug in this area is that value walking
/// a day when one end of the round trip uses a different zone.
///
/// `miles` is a `Double` holding an exact one-decimal value: ``TripDraft``
/// parses the seller's typing into integer tenths and divides at this boundary,
/// so every sum over this column is drift-free by construction.
///
/// It rides the single current schema version rather than earning a V2, the same
/// way `LocalProspectResult` does — pre-production there is no deployed store to
/// migrate from, and a V2 re-listing these live classes hashes identically to V1
/// and crashes launch (the duplicate-checksum trap in `GradeThreadSchema`).
@Model
final class LocalMileageTrip {
    // `tripDate` backs the log's `@Query(sort:)` and the per-year totals.
    // `id` is covered by its `@Attribute(.unique)` constraint.
    #Index<LocalMileageTrip>([\.tripDate])

    @Attribute(.unique) var id: String
    var tripDate: Date
    var miles: Double
    /// Free text on the server. A wire value from `TripDraft.purposes` when the
    /// seller picked one, whatever they typed when they did not.
    var purpose: String
    var startLocation: String?
    var endLocation: String?
    var roundTrip: Bool
    /// The sourcing trip this drive was for, when it is known.
    var sourceId: String?
    var createdAt: Date

    init(
        id: String,
        tripDate: Date,
        miles: Double,
        purpose: String,
        startLocation: String? = nil,
        endLocation: String? = nil,
        roundTrip: Bool = false,
        sourceId: String? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.tripDate = tripDate
        self.miles = miles
        self.purpose = purpose
        self.startLocation = startLocation
        self.endLocation = endLocation
        self.roundTrip = roundTrip
        self.sourceId = sourceId
        self.createdAt = createdAt
    }
}
