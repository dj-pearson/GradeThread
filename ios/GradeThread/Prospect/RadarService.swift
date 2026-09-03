import Foundation

/// US-1866 — the Thrift Radar read calls on iOS.
///
/// Everything goes through ``EdgeAPI/shared``, and that choice carries three
/// things this surface would otherwise have to re-implement:
///
///   • the snake_case → camelCase decoder the Radar routes need (the Prospect
///     scan next door uses a plain decoder, because the scout routes speak
///     camelCase — see ``RadarTypes``);
///   • the US-1213 plan gate: `interceptPlanSignals` decodes the 402 body and
///     hands it to ``PlanGateNotifier``, so the upgrade sheet appears without a
///     line of wiring here, and a Free seller never dead-ends on the network
///     layer;
///   • the bounded retry, backoff and 401 token refresh every other edge call
///     gets.
///
/// This client performs NO aggregation and applies NO k-anonymity floor. Both
/// live on the server: a below-floor venue is simply ABSENT from the response
/// rather than redacted in it, so there is no suppressed payload for the phone
/// to be trusted to hide.
@MainActor
protocol RadarReading {
    /// The nearby list. `bbox` is `minLat,minLng,maxLat,maxLng`.
    func venues(
        bbox: String,
        window: RadarWindow,
        brand: String?
    ) async throws -> RadarVenuesPayload

    /// One venue plus its per-brand breakdown.
    func venueDetail(id: String, window: RadarWindow) async throws -> RadarVenueDetailPayload

    /// The caller's own sourcing history per store. Free, ungated, works at n=1.
    func myStores(sort: String) async throws -> RadarPersonalStoresPayload

    /// US-3106: say that one of your sources IS a place on the map. `venueId`
    /// nil unlinks.
    @discardableResult
    func linkStore(sourceId: String, venueId: String?) async throws -> String?
}

@MainActor
final class RadarService: RadarReading {

    init() {}

    func venues(
        bbox: String,
        window: RadarWindow,
        brand: String?
    ) async throws -> RadarVenuesPayload {
        var query = [
            URLQueryItem(name: "bbox", value: bbox),
            URLQueryItem(name: "window", value: window.rawValue),
        ]
        if let brand, !brand.isEmpty {
            query.append(URLQueryItem(name: "brand", value: brand))
        }
        return try await get("/api/flipdesk/radar/venues", query: query)
    }

    func venueDetail(id: String, window: RadarWindow) async throws -> RadarVenueDetailPayload {
        try await get(
            "/api/flipdesk/radar/venues/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)",
            query: [URLQueryItem(name: "window", value: window.rawValue)]
        )
    }

    func myStores(sort: String) async throws -> RadarPersonalStoresPayload {
        try await get(
            "/api/flipdesk/radar/my-stores",
            query: [URLQueryItem(name: "sort", value: sort)]
        )
    }

    /// POST /my-stores/link — the join that makes the personal layer whole.
    ///
    /// Money lives on a source (items, spend, sales) and visits live on a venue;
    /// until somebody says they are the same shop the two halves cannot meet.
    /// Until now that somebody had to be at a desk: both empty states on this
    /// screen told a seller standing in a car park to go and do it on the web.
    ///
    /// The body is `{ source_id, venue_id }` — the same two keys
    /// `useLinkRadarStore` sends. It is spelled camelCase here because the
    /// shared ``EdgeAPI`` encoder converts to snake_case on the way out; see
    /// ``RadarLinkRequest``.
    @discardableResult
    func linkStore(sourceId: String, venueId: String?) async throws -> String? {
        do {
            let response: RadarLinkResponse = try await EdgeAPI.shared.postJSON(
                "/api/flipdesk/radar/my-stores/link",
                body: RadarLinkRequest(sourceId: sourceId, venueId: venueId)
            )
            return response.venueId
        } catch let error as EdgeAPIError {
            throw RadarService.mapped(error)
        }
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem]) async throws -> T {
        do {
            return try await EdgeAPI.shared.getJSON(path, query: query)
        } catch let error as EdgeAPIError {
            throw RadarService.mapped(error)
        }
    }

    /// Re-label the plan gate.
    ///
    /// `EdgeAPI` has already presented the upgrade sheet by the time this runs —
    /// the interception happens on the response, before the status is mapped —
    /// so this exists only so the LIST can render "the shared map is on Pro"
    /// instead of a raw `FEATURE_LOCKED`, and so ``isPlanGateError`` can hide a
    /// "Try again" that would only re-hit the same wall.
    ///
    /// The 402 body is mapped to `.badRequest(detail:)` upstream (there is no
    /// dedicated 402 case, and adding associated values to the shared enum would
    /// break dozens of existing matchers), so the discriminator is read back off
    /// the detail string — the same shape US-806 uses for
    /// `ACTIVE_STRIPE_SUBSCRIPTION`.
    static func mapped(_ error: EdgeAPIError) -> Error {
        guard case .badRequest(let detail) = error, let detail else { return error }
        if detail.hasPrefix("FEATURE_LOCKED") { return RadarError.networkLayerLocked }
        if detail.hasPrefix("CAP_REACHED") { return RadarError.quotaReached }
        return error
    }
}

/// Plan-gate outcomes on the Radar network layer (HTTP 402).
///
/// Both cases are gates, never transport failures, so ``isPlanGated`` is always
/// true and the UI suppresses its retry: the centralized upgrade prompt is
/// already on screen, and a second attempt would only produce a second one.
enum RadarError: LocalizedError, Equatable {
    /// The shared map is Pro+ (`compPulls`), the same flag the Prospect scan
    /// that feeds it uses.
    case networkLayerLocked
    case quotaReached

    var errorDescription: String? {
        switch self {
        case .networkLayerLocked:
            return "The shared map is a Pro feature. Your own stores stay on this list on every plan."
        case .quotaReached:
            return "You've hit your monthly limit for this. It resets next cycle — or upgrade for a higher cap."
        }
    }

    var isPlanGated: Bool { true }
}
