import Foundation
import Observation

/// The bits of ``RadarLocationProvider`` the Radar view needs, as a protocol so
/// the store is testable with no CoreLocation.
@MainActor
protocol RadarLocating {
    var isAuthorized: Bool { get }
    var hasBeenAsked: Bool { get }
    /// Ask for when-in-use access and wait for the user's answer.
    func requestAuthorization(timeout: TimeInterval) async -> Bool
    func currentFix(timeout: TimeInterval) async -> RadarFix?
}

extension RadarLocationProvider: RadarLocating {}

/// US-1866 — the Thrift Radar surface inside the Prospect module.
///
/// Three layers, three different rules, one list. Keeping them apart is most of
/// what this store is (full rule set: `vault/20-domain/thrift-radar.md`):
///
///   1. THE PERSONAL LAYER is free, needs no consent and works at n=1 (rule 7).
///      It loads first, it is never gated, and it is what everything else
///      degrades to — a locked plan, a failed request, an empty area and no
///      signal all end at the same honest list of the reseller's own stores.
///   2. THE NETWORK LAYER is Pro+, enforced by the endpoint. A 402 is not an
///      error here: ``EdgeAPI`` has already routed it to the upgrade sheet
///      (US-1213), so this store only records that the layer is locked and
///      keeps the personal one on screen.
///   3. THE K-ANONYMITY FLOOR is neither of those. It is applied server-side and
///      a below-floor venue is simply ABSENT, so no amount of paying reveals
///      it. What changes it is contributions — which is why the empty state
///      points at the toggle and not at the plan.
///
/// **Viewing is not contributing.** This store never writes
/// ``RadarConsent``, and nothing it does enrols anybody: the two are separate
/// consents (rule 1) and collapsing a read into a write is exactly what that
/// rule refuses. It reads the flag only to word the pitch correctly.
///
/// **Where location fits.** Radar opens with no permission prompt at all —
/// the reseller's own linked stores are places we already know, so the first
/// list is centred on those. iOS is asked where the phone is only when the user
/// taps "Use my location", and the answer is turned into a quantized bounding
/// box before it leaves the device. It is never sent as a scan.
@MainActor
@Observable
final class RadarStore {

    // MARK: - Inputs

    /// Which activity window the list is showing.
    var window: RadarWindow = .thirtyDays

    // MARK: - Personal layer

    private(set) var personal: [RadarPersonalStore] = []
    /// Recorded visits we could not attribute to a store, from the same payload.
    private(set) var unplacedVisits = 0
    private(set) var isLoadingPersonal = false
    private(set) var personalError: String?

    // MARK: - Network layer

    private(set) var venues: [RadarVenue] = []
    /// venue id → brand key → scans, from the per-brand refinement queries.
    private(set) var brandScans: [String: [String: Int]] = [:]
    private(set) var weights: [RadarBrandWeight] = []
    /// How many different people must have scanned somewhere before it appears.
    private(set) var kFloor = 0
    private(set) var isLoadingNetwork = false
    private(set) var networkError: String?
    /// Set by a 402. The upgrade sheet is already up by the time this is read.
    private(set) var networkLocked = false

    // MARK: - Location

    private(set) var area: RadarBoundingBox?
    /// Only set once the user has asked for their location, and only used to
    /// LABEL rows with a distance and break ranking ties. Never sent.
    private(set) var centre: RadarPoint?
    private(set) var isLocating = false
    private(set) var locationDenied = false
    private(set) var locationError: String?

    // MARK: - Dependencies

    private let service: RadarReading
    private let location: RadarLocating?
    private let consent: RadarConsent

    /// Whether the user contributes. Read-only here, and shown so the pitch can
    /// say the true thing — this store never changes it.
    var isContributing: Bool { consent.isContributing }

    // Built in the init BODY (main-actor isolated) rather than as default
    // arguments, which would evaluate in a nonisolated context.
    init(
        service: RadarReading? = nil,
        location: RadarLocating? = nil,
        consent: RadarConsent? = nil
    ) {
        self.service = service ?? RadarService()
        self.location = location ?? RadarLocationProvider.shared
        self.consent = consent ?? RadarConsent.shared
    }

    // MARK: - Derived list

    /// Whether asking iOS for a position could still add anything.
    var canAskForLocation: Bool {
        guard let location else { return false }
        return !location.hasBeenAsked || location.isAuthorized
    }

    /// The reseller's stores that have no place on the map yet. They hold real
    /// money, so they are listed separately rather than dropped.
    var offMapStores: [RadarPersonalStore] {
        personal.filter { $0.point == nil && $0.itemsSourced > 0 }
    }

    /// The ranked nearby list: venues, the reseller's own stores, and the ones
    /// that are both.
    ///
    /// A venue the network cannot speak about carries `score == nil` rather than
    /// zero. Zero would claim we looked and found it quiet; nil says we have
    /// nothing to say, which is the only honest reading of a k-floored silence.
    var rows: [RadarNearbyRow] {
        let mineByVenue = Dictionary(
            personal.compactMap { store in store.venueId.map { ($0, store) } },
            uniquingKeysWith: { first, _ in first }
        )

        var activities: [String: RadarVenueActivity] = [:]
        for venue in venues {
            activities[venue.id] = RadarVenueActivity(
                allScans: venue.network.scanCount,
                brandScans: brandScans[venue.id] ?? [:],
                daysSince: venue.network.daysSinceActivity
            )
        }
        let peak = activities.values
            .map { RadarScoring.weightedActivity($0, weights: weights) }
            .max() ?? 0

        var out: [RadarNearbyRow] = []
        for venue in venues {
            let activity = activities[venue.id] ?? RadarVenueActivity()
            out.append(RadarNearbyRow(
                id: venue.id,
                venueId: venue.id,
                name: venue.displayName,
                chain: venue.chain,
                distanceKm: distance(to: RadarPoint(lat: venue.lat, lng: venue.lng)),
                network: venue.network,
                personal: mineByVenue[venue.id],
                score: RadarScoring.hotnessScore(activity, weights: weights, peak: peak),
                point: RadarPoint(lat: venue.lat, lng: venue.lng)
            ))
        }

        // Whatever is left is a store of theirs the network has nothing to say
        // about — below the floor, or nobody else has been. These are the places
        // they actually go, so they stay on the list.
        let served = Set(venues.map(\.id))
        for store in personal {
            guard let venueId = store.venueId, !served.contains(venueId),
                  let point = store.point, covers(point) else { continue }
            out.append(RadarNearbyRow(
                id: venueId,
                venueId: venueId,
                name: store.name,
                chain: store.chain,
                distanceKm: distance(to: point),
                network: nil,
                personal: store,
                score: nil,
                point: point
            ))
        }

        return RadarScoring.rank(out)
    }

    private func distance(to point: RadarPoint) -> Double? {
        centre.map { RadarScoring.distanceKm($0, point) }
    }

    /// Inside the area currently being shown. With no area yet (nothing to
    /// centre on) every known store counts, so the first list is not empty.
    private func covers(_ point: RadarPoint) -> Bool {
        guard let area else { return true }
        return point.lat >= area.minLat && point.lat <= area.maxLat
            && point.lng >= area.minLng && point.lng <= area.maxLng
    }

    // MARK: - Loading

    /// First load: the free layer, then (if there is somewhere to look) the
    /// shared one. Never prompts for a permission.
    func load() async {
        await loadPersonal()
        if area == nil,
           let box = RadarScoring.boundingBox(covering: personal.compactMap(\.point)) {
            area = RadarScoring.quantize(box)
        }
        await loadNetwork()
    }

    func loadPersonal() async {
        isLoadingPersonal = true
        personalError = nil
        defer { isLoadingPersonal = false }
        do {
            let payload = try await service.myStores(sort: "roi")
            personal = payload.stores
            unplacedVisits = payload.unplacedVisits
            weights = RadarScoring.brandWeights(payload.stores)
        } catch {
            // The personal layer failing is the only real failure on this
            // screen: there is nothing further to fall back to.
            personalError = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't load your stores. Pull to refresh."
            )
            Telemetry.breadcrumb(
                "radar my-stores failed: \(FriendlyErrorCopy.rawDetail(for: error))",
                category: "radar"
            )
        }
    }

    /// The shared layer: one request for the venue totals, plus one per weighted
    /// brand.
    ///
    /// The brand requests are what make the list personal. `/venues` answers for
    /// ONE brand key at a time, so weighting toward the brands a reseller
    /// actually flips means asking for those brands' rows and folding them in —
    /// rather than adding a multi-brand parameter whose response would be a
    /// per-venue brand profile nobody asked for.
    func loadNetwork() async {
        guard let area, !networkLocked else { return }
        isLoadingNetwork = true
        networkError = nil
        defer { isLoadingNetwork = false }

        do {
            let total = try await service.venues(bbox: area.param, window: window, brand: nil)
            venues = total.venues
            kFloor = total.kFloor

            var scans: [String: [String: Int]] = [:]
            for weight in weights {
                // A brand refinement is a refinement. If one fails, the list is
                // still correct — just weighted a little less toward that brand
                // — so it must not blank a page that already loaded.
                guard let payload = try? await service.venues(
                    bbox: area.param, window: window, brand: weight.brand
                ) else { continue }
                for venue in payload.venues {
                    scans[venue.id, default: [:]][weight.brand] = venue.network.scanCount
                }
            }
            brandScans = scans
        } catch let error as RadarError {
            // Not a failure: the plan gate. EdgeAPI already presented the
            // upgrade sheet, so all that is left is to stop asking and leave the
            // personal layer on screen.
            networkLocked = true
            networkError = error.errorDescription
            venues = []
            brandScans = [:]
        } catch {
            networkError = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't load the shared map."
            )
            venues = []
            brandScans = [:]
            Telemetry.breadcrumb(
                "radar venues failed: \(FriendlyErrorCopy.rawDetail(for: error))",
                category: "radar"
            )
        }
    }

    /// Re-arm the network layer after a lock.
    ///
    /// The lock is sticky within a session so a Free seller is not shown the
    /// upgrade sheet on every window change. This is the deliberate way back in
    /// — an explicit tap, which re-hits the endpoint and lets the SERVER decide
    /// again (it is the only thing that knows whether they just upgraded).
    func checkNetworkAgain() async {
        networkLocked = false
        await loadNetwork()
    }

    func setWindow(_ next: RadarWindow) async {
        guard next != window else { return }
        window = next
        await loadNetwork()
    }

    func refresh() async {
        await loadPersonal()
        if area == nil,
           let box = RadarScoring.boundingBox(covering: personal.compactMap(\.point)) {
            area = RadarScoring.quantize(box)
        }
        await loadNetwork()
    }

    // MARK: - Location

    /// Centre the list on where the phone is.
    ///
    /// The permission is requested HERE, in the flow that needs it, and only
    /// when the user taps for it — never on appear, and never from a scan. The
    /// fix that comes back is turned into a quantized bounding box immediately;
    /// what leaves the device is a rectangle a few kilometres a side, and it is
    /// a query, not a contribution.
    func useMyLocation() async {
        guard let location else {
            locationError = "This device can't share a location."
            return
        }
        isLocating = true
        locationError = nil
        defer { isLocating = false }

        if !location.hasBeenAsked {
            _ = await location.requestAuthorization(timeout: 60)
        }
        guard location.isAuthorized else {
            locationDenied = true
            return
        }
        locationDenied = false

        guard let fix = await location.currentFix(timeout: 8) else {
            locationError = "Couldn't get your location just now. Try again in a moment."
            return
        }
        let point = RadarPoint(lat: fix.latitude, lng: fix.longitude)
        centre = point
        area = RadarScoring.quantize(RadarScoring.boundingBox(around: point))
        await loadNetwork()
    }

    /// US-3106: say that one of the seller's sources IS a venue on the map.
    ///
    /// Returns an error message, or nil on success. The personal layer is
    /// re-read on the way out rather than patched locally: the link changes
    /// which store owns which items, spend and sales, and the server is the one
    /// that knows the answer. Re-reading is one free, ungated call and it is
    /// what makes the venue show its personal panel immediately.
    func link(sourceId: String, venueId: String?) async -> String? {
        do {
            _ = try await service.linkStore(sourceId: sourceId, venueId: venueId)
            await loadPersonal()
            return nil
        } catch {
            return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - Venue detail

/// The venue detail screen's loader.
///
/// A venue below the k-floor and a venue that never existed return the IDENTICAL
/// 404 from the endpoint, so this cannot and must not tell them apart. What it
/// does instead is keep the reseller's OWN history for the place, which is
/// theirs regardless of the floor and shows at n=1.
@MainActor
@Observable
final class RadarVenueDetailStore {

    enum Phase: Equatable {
        case loading
        case ready(RadarVenueDetailPayload)
        /// Nothing servable. `planGated` distinguishes "upgrade sheet is already
        /// up" from a floor/absence, so the view can drop a dead-end retry.
        case withheld(message: String, planGated: Bool)
    }

    private(set) var phase: Phase = .loading

    private let service: RadarReading

    init(service: RadarReading? = nil) {
        self.service = service ?? RadarService()
    }

    func load(venueId: String, window: RadarWindow) async {
        phase = .loading
        do {
            phase = .ready(try await service.venueDetail(id: venueId, window: window))
        } catch let error as RadarError {
            phase = .withheld(
                message: error.errorDescription ?? RadarCopy.notEnough,
                planGated: true
            )
        } catch let error as EdgeAPIError {
            if case .notFound = error {
                phase = .withheld(message: RadarCopy.floorExplainer, planGated: false)
            } else {
                phase = .withheld(
                    message: FriendlyErrorCopy.actionMessage(
                        for: error,
                        fallback: "Couldn't load this store."
                    ),
                    planGated: false
                )
            }
        } catch {
            phase = .withheld(
                message: FriendlyErrorCopy.actionMessage(
                    for: error,
                    fallback: "Couldn't load this store."
                ),
                planGated: false
            )
        }
    }
}

/// The sentences the k-floor forces, in one place.
///
/// They are deliberately the SAME for a venue nobody has scanned and a venue two
/// people have scanned. Distinguishing them would answer "did anyone scan
/// here?", which is the exact question the floor exists to refuse. Kept verbatim
/// in step with `src/components/flipdesk/radar-venue-panel.tsx`.
enum RadarCopy {
    static let notEnough = "Not enough data here yet — contributions unlock this."

    static let floorExplainer =
        "Not enough people have scanned here yet for us to say anything about this "
        + "store without giving away who they were. Turning on contributions in "
        + "Settings is what changes that."

    static let contributionPitch =
        "Radar only shows a store once enough different people have scanned there, "
        + "so a quiet area means quiet contributors, not a dead area. Turning "
        + "contributions on sends the store and the brand from your scans, never a "
        + "coordinate and never your name."

    static let viewingIsNotContributing =
        "Opening Radar never enrols you as a contributor — looking and sharing are "
        + "separate switches."
}
