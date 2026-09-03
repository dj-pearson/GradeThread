import XCTest
@testable import GradeThread

/// US-1866 — the Thrift Radar surface's behaviour, with no network and no
/// CoreLocation.
///
/// The cases worth having here are the ones where getting it wrong is invisible
/// rather than broken: a screen that quietly enrols a viewer as a contributor
/// still renders perfectly, and so does one that asks iOS where the phone is
/// before anybody tapped for it. Those are asserted directly.
@MainActor
final class RadarStoreTests: XCTestCase {

    // MARK: - Fakes

    private final class FakeRadarService: RadarReading {
        /// Keyed by brand; "" is the all-brands total.
        var venuesByBrand: [String: [RadarVenue]] = [:]
        var kFloor = 3
        var stores: [RadarPersonalStore] = []
        var unplacedVisits = 0
        /// Thrown by the all-brands query only, so a brand refinement can be
        /// failed independently.
        var venuesError: Error?
        var storesError: Error?
        var detail: RadarVenueDetailPayload?
        var detailError: Error?

        private(set) var venueCalls: [(bbox: String, window: RadarWindow, brand: String?)] = []
        private(set) var storeCalls = 0
        private(set) var detailCalls = 0

        func venues(
            bbox: String,
            window: RadarWindow,
            brand: String?
        ) async throws -> RadarVenuesPayload {
            venueCalls.append((bbox, window, brand))
            if let venuesError, brand == nil { throw venuesError }
            return RadarVenuesPayload(
                window: window.rawValue,
                brand: brand,
                kFloor: kFloor,
                venues: venuesByBrand[brand ?? ""] ?? []
            )
        }

        func venueDetail(id: String, window: RadarWindow) async throws -> RadarVenueDetailPayload {
            detailCalls += 1
            if let detailError { throw detailError }
            return detail ?? RadarVenueDetailPayload()
        }

        func myStores(sort: String) async throws -> RadarPersonalStoresPayload {
            storeCalls += 1
            if let storesError { throw storesError }
            return RadarPersonalStoresPayload(
                sort: sort,
                stores: stores,
                unplacedVisits: unplacedVisits
            )
        }

        // US-3106
        private(set) var linkCalls: [(sourceId: String, venueId: String?)] = []
        var linkError: Error?

        @discardableResult
        func linkStore(sourceId: String, venueId: String?) async throws -> String? {
            linkCalls.append((sourceId, venueId))
            if let linkError { throw linkError }
            return venueId
        }
    }

    private final class FakeLocation: RadarLocating {
        var isAuthorized = false
        var hasBeenAsked = false
        /// What the system prompt would answer.
        var grantOnRequest = false
        var fix: RadarFix?

        private(set) var authorizationRequests = 0
        private(set) var fixRequests = 0

        func requestAuthorization(timeout: TimeInterval) async -> Bool {
            authorizationRequests += 1
            hasBeenAsked = true
            isAuthorized = grantOnRequest
            return isAuthorized
        }

        func currentFix(timeout: TimeInterval) async -> RadarFix? {
            fixRequests += 1
            return fix
        }
    }

    // MARK: - Fixtures

    private func consent() -> RadarConsent {
        // A throwaway suite so a test can never read or write the real toggle.
        RadarConsent(defaults: UserDefaults(suiteName: "radar-tests-\(UUID().uuidString)")!)
    }

    private func personalStore(
        key: String,
        venueId: String? = nil,
        lat: Double? = nil,
        lng: Double? = nil,
        items: Int = 3,
        brands: [(String, Int)] = []
    ) -> RadarPersonalStore {
        RadarPersonalStore(
            key: key,
            sourceId: key,
            venueId: venueId,
            name: key.capitalized,
            lat: lat,
            lng: lng,
            linked: venueId != nil,
            itemsSourced: items,
            spendCents: 5_000,
            realizedProfitCents: 9_000,
            roiPct: 80,
            topBrands: brands.map { RadarPersonalBrand(brand: $0.0, items: $0.1) },
            visits: 2
        )
    }

    private func venue(
        id: String,
        name: String,
        lat: Double = 39.1,
        lng: Double = -94.6,
        scans: Int,
        contributors: Int = 4,
        daysSince: Int? = 0
    ) -> RadarVenue {
        RadarVenue(
            id: id,
            displayName: name,
            lat: lat,
            lng: lng,
            network: RadarNetworkStats(
                venueId: id,
                scanCount: scans,
                contributorCount: contributors,
                daysSinceActivity: daysSince
            )
        )
    }

    // The default is nil rather than `FakeLocation()` because a DEFAULT
    // ARGUMENT is evaluated in a nonisolated context, even on a @MainActor
    // type. `FakeLocation` is nested in this @MainActor class and so inherits
    // its isolation, which made the old default "call to main actor-isolated
    // initializer 'init()' in a synchronous nonisolated context" — an error
    // that only surfaces on the CI toolchain. Constructing it in the BODY is
    // the fix: the body is MainActor-isolated, the default expression is not.
    private func makeStore(
        service: FakeRadarService,
        location: FakeLocation? = nil,
        consent: RadarConsent? = nil
    ) -> RadarStore {
        RadarStore(
            service: service,
            location: location ?? FakeLocation(),
            consent: consent ?? self.consent()
        )
    }

    // MARK: - Consent and location (AC2)

    func testOpeningRadarNeverAsksForALocation() async {
        let service = FakeRadarService()
        service.stores = [personalStore(key: "goodwill", venueId: "v1", lat: 39.1, lng: -94.6)]
        let location = FakeLocation()
        let store = makeStore(service: service, location: location)

        await store.load()

        // The permission belongs to the flow that needs it, on a tap. A prompt
        // on appear is the thing this whole surface is designed not to do.
        XCTAssertEqual(location.authorizationRequests, 0)
        XCTAssertEqual(location.fixRequests, 0)
        // …and there is still something to look at: the personal layer needs no
        // position at all, because a linked store already has one.
        XCTAssertNotNil(store.area)
    }

    func testViewingDoesNotEnrolTheUserAsAContributor() async {
        let service = FakeRadarService()
        service.stores = [personalStore(key: "goodwill", venueId: "v1", lat: 39.1, lng: -94.6)]
        let location = FakeLocation()
        location.grantOnRequest = true
        location.fix = RadarFix(latitude: 39.1, longitude: -94.6)
        let radarConsent = consent()
        let store = makeStore(service: service, location: location, consent: radarConsent)

        await store.load()
        await store.useMyLocation()

        // Looking and contributing are separate consents (rule 1). Using the
        // Radar view — including sharing a location with it — must leave the
        // contribution switch exactly where the user left it.
        XCTAssertFalse(radarConsent.isContributing)
        XCTAssertFalse(store.isContributing)
    }

    func testUseMyLocationAsksThenFixesThenReloads() async {
        let service = FakeRadarService()
        let location = FakeLocation()
        location.grantOnRequest = true
        location.fix = RadarFix(latitude: 39.5127, longitude: -98.3312)
        let store = makeStore(service: service, location: location)

        await store.useMyLocation()

        XCTAssertEqual(location.authorizationRequests, 1)
        XCTAssertEqual(location.fixRequests, 1)
        XCTAssertFalse(store.locationDenied)
        XCTAssertNotNil(store.centre)
        XCTAssertFalse(service.venueCalls.isEmpty)
    }

    func testTheAreaSentIsQuantizedNotTheFix() async throws {
        let service = FakeRadarService()
        let location = FakeLocation()
        location.grantOnRequest = true
        location.fix = RadarFix(latitude: 39.5127, longitude: -98.3312)
        let store = makeStore(service: service, location: location)

        await store.useMyLocation()

        let sent = try XCTUnwrap(service.venueCalls.first?.bbox)
        // Every corner sits on the 0.05° grid, so the request is a rectangle a
        // few km a side and not a four-decimal-place report of where the phone
        // is. Keeping the coordinate out of the database would mean little if it
        // went out in the query string instead.
        for component in sent.split(separator: ",") {
            let value = Double(component) ?? .nan
            XCTAssertEqual((value / 0.05).rounded(), value / 0.05, accuracy: 0.0001)
        }
        XCTAssertFalse(sent.contains("39.5127"))
        XCTAssertFalse(sent.contains("-98.3312"))
    }

    func testDeniedLocationIsExplainedRatherThanRetried() async {
        let service = FakeRadarService()
        let location = FakeLocation()
        location.grantOnRequest = false
        let store = makeStore(service: service, location: location)

        await store.useMyLocation()

        XCTAssertTrue(store.locationDenied)
        // No fix is requested once the answer is no — asking anyway is how an
        // app ends up collecting what it was told not to.
        XCTAssertEqual(location.fixRequests, 0)
        XCTAssertNil(store.centre)
    }

    // MARK: - Plan gate (AC3)

    func testPlanGateLocksTheNetworkLayerAndKeepsThePersonalOne() async {
        let service = FakeRadarService()
        service.stores = [personalStore(key: "goodwill", venueId: "v1", lat: 39.1, lng: -94.6)]
        service.venuesError = RadarError.networkLayerLocked
        let store = makeStore(service: service)

        await store.load()

        XCTAssertTrue(store.networkLocked)
        XCTAssertTrue(store.venues.isEmpty)
        // Not a dead end: EdgeAPI already presented the upgrade sheet, and the
        // reseller's own store is still on the list.
        XCTAssertEqual(store.rows.map(\.name), ["Goodwill"])
        XCTAssertNil(store.rows.first?.score)
    }

    func testALockedNetworkLayerStopsRequestingUntilAskedAgain() async {
        let service = FakeRadarService()
        service.stores = [personalStore(key: "goodwill", venueId: "v1", lat: 39.1, lng: -94.6)]
        service.venuesError = RadarError.networkLayerLocked
        let store = makeStore(service: service)

        await store.load()
        let afterFirst = service.venueCalls.count
        await store.setWindow(.sevenDays)
        // A Free seller changing the window must not get a second upgrade sheet.
        XCTAssertEqual(service.venueCalls.count, afterFirst)

        service.venuesError = nil
        service.venuesByBrand[""] = [venue(id: "v1", name: "Goodwill", scans: 12)]
        await store.checkNetworkAgain()

        // …but the explicit way back in re-asks the server, which is the only
        // thing that knows whether they just upgraded.
        XCTAssertGreaterThan(service.venueCalls.count, afterFirst)
        XCTAssertFalse(store.networkLocked)
        XCTAssertEqual(store.venues.count, 1)
    }

    func testPlanGateErrorsAreClassifiedAsGated() {
        XCTAssertTrue(isPlanGateError(RadarError.networkLayerLocked))
        XCTAssertTrue(isPlanGateError(RadarError.quotaReached))
        XCTAssertFalse(isPlanGateError(EdgeAPIError.network("offline")))
    }

    func testEdgeApiPlanGateBodyIsMappedToARadarError() {
        // The 402 body has no dedicated EdgeAPIError case (adding associated
        // values to the shared enum would break dozens of matchers), so the
        // discriminator is read back off the detail string.
        XCTAssertEqual(
            RadarService.mapped(.badRequest(detail: "FEATURE_LOCKED")) as? RadarError,
            .networkLayerLocked
        )
        XCTAssertEqual(
            RadarService.mapped(.badRequest(detail: "CAP_REACHED")) as? RadarError,
            .quotaReached
        )
        XCTAssertNil(RadarService.mapped(.badRequest(detail: "something else")) as? RadarError)
    }

    // MARK: - Degrading (AC4)

    func testANetworkFailureFallsBackToThePersonalLayer() async {
        let service = FakeRadarService()
        service.stores = [personalStore(key: "goodwill", venueId: "v1", lat: 39.1, lng: -94.6)]
        service.venuesError = EdgeAPIError.network("The Internet connection appears to be offline.")
        let store = makeStore(service: service)

        await store.load()

        XCTAssertNotNil(store.networkError)
        XCTAssertFalse(store.networkLocked)
        XCTAssertEqual(store.rows.count, 1)
    }

    func testAFailedBrandRefinementDoesNotBlankTheList() async {
        let service = FakeRadarService()
        service.stores = [
            personalStore(key: "goodwill", venueId: "v1", lat: 39.1, lng: -94.6,
                          brands: [("Nike", 4)]),
        ]
        service.venuesByBrand[""] = [venue(id: "v1", name: "Goodwill", scans: 9)]
        // No entry for "nike" ⇒ an empty refinement, which lands as a zero
        // rather than as a missing venue.
        let store = makeStore(service: service)

        await store.load()

        XCTAssertEqual(store.venues.count, 1)
        XCTAssertEqual(store.rows.first?.name, "Goodwill")
    }

    func testStoresThatAreNotOnTheMapAreListedSeparately() async {
        let service = FakeRadarService()
        service.stores = [
            personalStore(key: "linked", venueId: "v1", lat: 39.1, lng: -94.6),
            personalStore(key: "unlinked", items: 5),
        ]
        let store = makeStore(service: service)

        await store.load()

        XCTAssertEqual(store.offMapStores.map(\.key), ["unlinked"])
        XCTAssertFalse(store.rows.contains { $0.name == "Unlinked" })
    }

    func testThePersonalLayerFailingIsTheOnlyRealFailure() async {
        let service = FakeRadarService()
        service.storesError = EdgeAPIError.network("offline")
        let store = makeStore(service: service)

        await store.load()

        XCTAssertNotNil(store.personalError)
        XCTAssertTrue(store.rows.isEmpty)
    }

    // MARK: - The blended list (AC1)

    func testABelowFloorVenueSimplyIsNotThere() async {
        let service = FakeRadarService()
        service.kFloor = 3
        service.stores = [
            personalStore(key: "served", venueId: "v1", lat: 39.1, lng: -94.6),
            personalStore(key: "quiet", venueId: "v2", lat: 39.12, lng: -94.62),
        ]
        // The endpoint omits a venue that has not cleared the floor; there is no
        // redacted payload for the client to hide.
        service.venuesByBrand[""] = [venue(id: "v1", name: "Served", scans: 11)]
        let store = makeStore(service: service)

        await store.load()

        let rows = store.rows
        XCTAssertEqual(rows.map(\.name), ["Served", "Quiet"])
        XCTAssertNotNil(rows[0].network)
        XCTAssertNotNil(rows[0].score)
        // The reseller's own store survives the floor — it is theirs, and it
        // reads as "nothing shared about this place yet", not as "quiet".
        XCTAssertNil(rows[1].network)
        XCTAssertNil(rows[1].score)
        XCTAssertNotNil(rows[1].personal)
    }

    func testTheListIsWeightedTowardTheBrandsTheResellerFlips() async {
        let service = FakeRadarService()
        service.stores = [
            personalStore(key: "home", venueId: nil, lat: nil, lng: nil,
                          brands: [("Nike", 6)]),
        ]
        service.venuesByBrand[""] = [
            venue(id: "busy", name: "Busy", scans: 10),
            venue(id: "matched", name: "Matched", scans: 8),
        ]
        service.venuesByBrand["nike"] = [venue(id: "matched", name: "Matched", scans: 8)]

        // No linked stores, so no area comes from the personal layer — the user
        // shares a location instead.
        let location = FakeLocation()
        location.grantOnRequest = true
        location.fix = RadarFix(latitude: 39.1, longitude: -94.6)
        let store = makeStore(service: service, location: location)
        await store.loadPersonal()
        await store.useMyLocation()

        XCTAssertEqual(store.weights.map(\.brand), ["nike"])
        // 8 matched scans (×2 boost) outrank 10 unmatched ones — but the busier
        // store is still listed, because weighting is not filtering.
        XCTAssertEqual(store.rows.map(\.name), ["Matched", "Busy"])
    }

    func testChangingTheWindowRefetchesTheNetworkLayer() async {
        let service = FakeRadarService()
        service.stores = [personalStore(key: "goodwill", venueId: "v1", lat: 39.1, lng: -94.6)]
        service.venuesByBrand[""] = [venue(id: "v1", name: "Goodwill", scans: 5)]
        let store = makeStore(service: service)

        await store.load()
        let before = service.venueCalls.count
        await store.setWindow(.ninetyDays)

        XCTAssertEqual(store.window, .ninetyDays)
        XCTAssertGreaterThan(service.venueCalls.count, before)
        XCTAssertEqual(service.venueCalls.last?.window, .ninetyDays)
    }

    // MARK: - Venue detail

    func testDetailBelowTheFloorReadsAsWithheldWithARetry() async {
        let service = FakeRadarService()
        service.detailError = EdgeAPIError.notFound(detail: "Venue not found")
        let detail = RadarVenueDetailStore(service: service)

        await detail.load(venueId: "v1", window: .thirtyDays)

        guard case .withheld(let message, let planGated) = detail.phase else {
            return XCTFail("expected a withheld phase, got \(detail.phase)")
        }
        // A venue below the floor and a venue that never existed get the
        // IDENTICAL 404, so this copy must not guess which one happened.
        XCTAssertEqual(message, RadarCopy.floorExplainer)
        XCTAssertFalse(planGated)
    }

    func testDetailBehindThePlanWallDropsTheRetry() async {
        let service = FakeRadarService()
        service.detailError = RadarError.networkLayerLocked
        let detail = RadarVenueDetailStore(service: service)

        await detail.load(venueId: "v1", window: .thirtyDays)

        guard case .withheld(_, let planGated) = detail.phase else {
            return XCTFail("expected a withheld phase, got \(detail.phase)")
        }
        // The upgrade sheet is already up; a "Try again" would only produce a
        // second one.
        XCTAssertTrue(planGated)
    }

    func testDetailReadyCarriesTheBrandBreakdown() async {
        let service = FakeRadarService()
        service.detail = RadarVenueDetailPayload(
            kFloor: 3,
            venue: RadarVenueSummary(id: "v1", displayName: "Goodwill"),
            network: RadarNetworkStats(venueId: "v1", scanCount: 12, contributorCount: 4),
            brands: [RadarNetworkStats(venueId: "v1", brand: "nike", scanCount: 5)]
        )
        let detail = RadarVenueDetailStore(service: service)

        await detail.load(venueId: "v1", window: .thirtyDays)

        guard case .ready(let payload) = detail.phase else {
            return XCTFail("expected a ready phase, got \(detail.phase)")
        }
        XCTAssertEqual(payload.brands.first?.brand, "nike")
    }
}
