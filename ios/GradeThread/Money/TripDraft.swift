import Foundation

/// US-3014 — a mileage trip, entered at the shop rather than on a laptop three
/// weeks later.
///
/// PURE, like Android's `TripDraft`, so the rules are testable with no database
/// and no SwiftUI harness. Miles are held as the RAW TEXT the seller typed: a
/// half-finished "12." has to stay on screen exactly as entered instead of
/// snapping to "12.0" under the cursor.
///
/// `tripDate` is an anchor for a CALENDAR DAY, not a moment, and every read and
/// write of it goes through ``MoneyDate``. That is AC2: `trip_date` is the same
/// shape of column as `spent_on`, and US-2339 is `spent_on` walking back a day
/// per edit because the parse and the format disagreed about the zone.
struct TripDraft: Equatable {

    /// Non-nil when editing an existing row, so a save upserts rather than
    /// minting a second trip for the same drive.
    var id: String?
    var milesText: String = ""
    var purpose: String = TripDraft.defaultPurpose
    var tripDate: Date
    var startLocation: String = ""
    var endLocation: String = ""
    var roundTrip: Bool = false
    /// Optional attribution to the sourcing trip this drive was for.
    var sourceId: String?

    init(
        id: String? = nil,
        milesText: String = "",
        purpose: String = TripDraft.defaultPurpose,
        tripDate: Date,
        startLocation: String = "",
        endLocation: String = "",
        roundTrip: Bool = false,
        sourceId: String? = nil
    ) {
        self.id = id
        self.milesText = milesText
        self.purpose = purpose
        self.tripDate = tripDate
        self.startLocation = startLocation
        self.endLocation = endLocation
        self.roundTrip = roundTrip
        self.sourceId = sourceId
    }

    /// A new trip for today, anchored the way every stored date is.
    static func today(sourceId: String? = nil, now: Date = .now) -> TripDraft {
        TripDraft(tripDate: MoneyDate.today(now: now), sourceId: sourceId)
    }

    // MARK: - Miles

    /// Tenths of a mile, as an integer, because the column is `numeric(8,1)`.
    ///
    /// Parsed to an integer for the same reason money is parsed to cents: 12.3
    /// has no exact binary representation, and a log that quietly records
    /// 12.299999999999999 miles produces a deduction that will not reconcile
    /// against the seller's own arithmetic when somebody checks it.
    var tenthsOfMile: Int? {
        let raw = milesText
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: ",", with: "")
        if raw.isEmpty { return nil }

        let parts = raw.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        // More than one separator, or anything that is not a digit, is not a
        // number. Rejected here rather than coerced: "1.2.3" silently becoming
        // 1.2 puts miles in the log the seller never typed.
        guard parts.count <= 2 else { return nil }
        let wholeText = String(parts.first ?? "")
        let fracText = parts.count == 2 ? String(parts[1]) : ""
        guard wholeText.allSatisfy(\.isNumber), fracText.allSatisfy(\.isNumber) else {
            return nil
        }
        if wholeText.isEmpty && fracText.isEmpty { return nil }

        let whole = wholeText.isEmpty ? 0 : Int(wholeText)
        guard let whole else { return nil }

        // ONE decimal place. A second is TRUNCATED, not rounded: rounding 12.35
        // up to 12.4 invents a distance the seller did not drive, and the column
        // cannot hold it anyway.
        let tenths = fracText.first.flatMap { $0.wholeNumberValue } ?? 0
        return whole * 10 + tenths
    }

    var miles: Double? {
        guard let tenthsOfMile else { return nil }
        return Double(tenthsOfMile) / 10.0
    }

    // MARK: - Validation

    enum Invalid: Equatable {
        case noMiles
        case zeroMiles
        case tooManyMiles
        case noPurpose

        /// Copy in the seller's words. Money/ is outside the localization
        /// migration front (`ios/Scripts/no-bare-strings.py` SCOPE_DIRS), so
        /// these are plain strings here for the same reason the rest of this
        /// folder's are; when Money joins the front they move with it.
        var message: String {
            switch self {
            case .noMiles: return "How many miles was it?"
            case .zeroMiles: return "A trip has to be more than zero miles."
            case .tooManyMiles: return "That is further than we can record for one trip."
            case .noPurpose: return "What was the trip for? \"Business\" is not a purpose."
            }
        }
    }

    /// The server's CHECK is `miles > 0 AND miles < 100000`, in TENTHS here
    /// because that is the unit this type carries.
    static let maxTenths = 1_000_000

    /// Why this cannot be saved, or nil when it is fine.
    ///
    /// Validated on THIS side as well as the server's, for two reasons that are
    /// not the same: the message stays in words the seller wrote, and a row
    /// Postgres will never accept never reaches the offline queue, where it
    /// would retry on every reconnect for ever.
    var invalidReason: Invalid? {
        guard let tenths = tenthsOfMile else { return .noMiles }
        if tenths == 0 { return .zeroMiles }
        if tenths >= TripDraft.maxTenths { return .tooManyMiles }
        if purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .noPurpose
        }
        return nil
    }

    var isValid: Bool { invalidReason == nil }

    // MARK: - Purposes

    static let defaultPurpose = "sourcing"

    /// What a reseller actually drives for.
    ///
    /// The wire value is stored verbatim in a free-text `purpose` column, so
    /// these are only what the picker offers — a seller can still type their
    /// own, and the IRS asks for the purpose in the seller's own terms anyway.
    static let purposes: [(wire: String, label: String)] = [
        ("sourcing", "Sourcing"),
        ("post_office", "Post office"),
        ("supplies", "Supplies"),
        ("consignor", "Consignor pickup"),
        ("other", "Other"),
    ]

    /// The label for a wire value, or nil when the seller typed their own.
    ///
    /// Nil rather than the raw wire string: the caller can show what was typed,
    /// and returning the wire value from here would put "post_office" on screen
    /// the day one of these ids changes.
    static func label(forWire wire: String) -> String? {
        purposes.first { $0.wire == wire }?.label
    }

    /// What to show for a purpose, whatever its origin.
    static func displayPurpose(_ wire: String) -> String {
        label(forWire: wire) ?? wire
    }
}
