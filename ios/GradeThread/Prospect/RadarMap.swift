import CoreLocation
import SwiftUI

/// US-3106 — the Radar list, on a map.
///
/// ⚠️ READ THIS BEFORE ADDING ANY OTHER MAP. `RadarNearbyView` was built
/// deliberately without one, and its header said so: **tile URLs ARE the
/// viewport**, so panning a third-party tile map streams the seller's
/// neighbourhood to whoever serves the tiles — the exact disclosure the schema
/// underneath (US-1862's geohash cells, US-1866's k-anonymity floor) exists to
/// withhold.
///
/// MapKit is a different proposition and that difference is the whole
/// justification: it is Apple's own framework on Apple's own device, under the
/// platform privacy terms the seller already accepted, with no host to add to
/// the ATS allowlist and no subprocessor to declare. Nothing here sends a
/// coordinate anywhere GradeThread controls, and the PINS are geohash cell
/// centres — identical for everyone in the cell, which is what makes them safe
/// to draw at all.
///
/// A tile URL of ours, or any third-party map SDK, remains refused.
struct RadarMapPin: Equatable, Identifiable {
    /// The row this pin belongs to, so a tap can scroll the list to it.
    let id: String
    let name: String
    let lat: Double
    let lng: Double
    /// Nil when the network has nothing servable about this place — below the
    /// k-floor, or nobody else has been. The pin still draws: it is one of the
    /// seller's own stores and they know it is there.
    let level: RadarHotnessLevel?
    /// True when the seller has sourced here. Their own places read differently
    /// from everyone else's, which is the point of the personal layer.
    let isMine: Bool

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

extension RadarMapPin {

    /// The pins for a ranked list. PURE, so "the map shows what the list shows"
    /// is a claim a test can check.
    ///
    /// A row with no coordinate is DROPPED rather than placed at (0, 0), which
    /// is a real point in the Gulf of Guinea and the classic way an unplaced
    /// record turns into a confident pin a thousand miles from anywhere.
    static func pins(from rows: [RadarNearbyRow]) -> [RadarMapPin] {
        rows.compactMap { row in
            guard let point = row.point else { return nil }
            return RadarMapPin(
                id: row.id,
                name: row.name,
                lat: point.lat,
                lng: point.lng,
                level: row.level,
                isMine: (row.personal?.itemsSourced ?? 0) > 0
            )
        }
    }

    /// A region that contains every pin, with a little air around it.
    ///
    /// Nil for no pins: a map centred on nothing is a map of the Atlantic, and
    /// the caller hides itself instead. A single pin gets the minimum span
    /// rather than a zero-sized one, which MapKit renders as a maximum zoom
    /// somewhere inside the building.
    static func region(for pins: [RadarMapPin]) -> RadarMapRegion? {
        guard let first = pins.first else { return nil }

        var minLat = first.lat, maxLat = first.lat
        var minLng = first.lng, maxLng = first.lng
        for pin in pins.dropFirst() {
            minLat = min(minLat, pin.lat)
            maxLat = max(maxLat, pin.lat)
            minLng = min(minLng, pin.lng)
            maxLng = max(maxLng, pin.lng)
        }

        let padding = 1.35
        return RadarMapRegion(
            centerLat: (minLat + maxLat) / 2,
            centerLng: (minLng + maxLng) / 2,
            spanLat: max((maxLat - minLat) * padding, minimumSpan),
            spanLng: max((maxLng - minLng) * padding, minimumSpan)
        )
    }

    /// About 2.2 km at the equator. Wide enough that a lone store shows its
    /// street rather than its roof.
    static let minimumSpan: Double = 0.02
}

/// The numbers a map region is made of, without MapKit in the arithmetic.
///
/// Separate from `MKCoordinateRegion` because that type is not `Equatable`,
/// which turns asserting on one into comparing four doubles by hand at every
/// call site — and because keeping the maths free of MapKit is what lets
/// ``RadarMapPin/region(for:)`` be tested rather than looked at.
struct RadarMapRegion: Equatable {
    let centerLat: Double
    let centerLng: Double
    let spanLat: Double
    let spanLng: Double
}

extension RadarHotnessLevel {
    /// The brand colour for this band.
    ///
    /// One switch, read by both the list badge and the map pin. Two copies is
    /// how a store reads amber on one and red on the other, which tells the
    /// seller the two disagree about the same number.
    var tint: Color {
        switch self {
        case .quiet: return .secondary
        case .warm: return Color.brandAmber
        case .hot: return .orange
        case .peak: return Color.brandRed
        }
    }
}
