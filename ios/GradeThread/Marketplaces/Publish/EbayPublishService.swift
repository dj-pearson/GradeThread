import Foundation

/// Wraps the four publish + manage endpoints behind a single Swift
/// surface. Each method returns a `PublishOutcome` rather than throwing
/// so callers can switch over the cases — the typed result includes
/// the 409 "no offer id" branch and the 422 "blockers" branch that the
/// raw `EdgeAPIError` would collapse together.
@MainActor
public final class EbayPublishService {

    private let baseURL: URL
    private let session: URLSession

    // US-1407: bounded session (was `URLSession.shared` = 60s) so a hung publish
    // / revise / price request fails fast instead of spinning behind the action.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - Validate

    func validate(inventoryItemId: String) async -> PublishOutcome {
        struct Body: Encodable { let inventory_item_id: String }
        do {
            let response: ValidateResponse = try await postJSON(
                path: "/api/flipdesk/ebay/listings/validate",
                body: Body(inventory_item_id: inventoryItemId)
            )
            return .validated(response)
        } catch let error as PublishHTTPError {
            return outcome(from: error)
        } catch {
            return .failed(message: Self.networkFailureMessage(error))
        }
    }

    // MARK: - Push

    /// Publishes the item to eBay. Pass `relist: true` when the item was
    /// previously listed (an ended draft, or a still-live listing being
    /// replaced): if a live listing still exists the server ends it first so
    /// this mints a brand-new listing instead of adopting the live one.
    /// `relist` is only sent when true so a normal first publish is unchanged.
    func push(inventoryItemId: String, relist: Bool = false) async -> PublishOutcome {
        struct Body: Encodable {
            let inventory_item_id: String
            let relist: Bool?
        }
        do {
            let response: PushResponse = try await postJSON(
                path: "/api/flipdesk/ebay/listings/push",
                body: Body(
                    inventory_item_id: inventoryItemId,
                    relist: relist ? true : nil
                )
            )
            return .pushed(response)
        } catch let error as PublishHTTPError {
            return outcome(from: error)
        } catch {
            return .failed(message: Self.networkFailureMessage(error))
        }
    }

    // MARK: - Price

    func updatePrice(listingId: String, price: Double) async -> PublishOutcome {
        // US-1241: catch a 0/negative price before the round-trip (the composer
        // and BulkPricing already guard their inputs, but this entry point didn't)
        // so it returns clear copy instead of an opaque edge failure.
        guard price > 0 else {
            return .failed(message: "Enter a listing price greater than zero before updating.")
        }
        struct Body: Encodable { let price: Double }
        let path = "/api/flipdesk/ebay/listings/\(listingId)/price"
        do {
            let response: PriceUpdateResponse = try await postJSON(
                path: path,
                body: Body(price: price)
            )
            return .priceUpdated(response)
        } catch let error as PublishHTTPError {
            return outcome(from: error)
        } catch {
            return .failed(message: Self.networkFailureMessage(error))
        }
    }

    // MARK: - Revise (edit a live listing in place)

    /// Pushes title / description / price / photo-order edits to a live eBay
    /// listing. `syncPhotos` forces the inventory_item re-PUT so the current
    /// photo set + order reach eBay even when no text field changed — eBay
    /// blocks editing inventory-based listings on its own site, so this is the
    /// supported path. All text fields are optional; omit one to leave it as
    /// published.
    func revise(
        listingId: String,
        title: String? = nil,
        description: String? = nil,
        price: Double? = nil,
        syncPhotos: Bool = false
    ) async -> ReviseOutcome {
        // Synthesized Encodable uses encodeIfPresent for optionals, so nil
        // fields are omitted from the body (the server treats missing as
        // "no change"). `photos` is sent only when a sync is requested.
        struct Body: Encodable {
            let title: String?
            let description: String?
            let listing_price: Double?
            let photos: Bool?
        }
        let path = "/api/flipdesk/ebay/listings/\(listingId)/revise"
        do {
            let response: ReviseResponse = try await postJSON(
                path: path,
                body: Body(
                    title: title,
                    description: description,
                    listing_price: price,
                    photos: syncPhotos ? true : nil
                )
            )
            return .revised(response)
        } catch let error as PublishHTTPError {
            // US-1190: route through the revise-specific mapper so revise gets
            // the same plan-limit (402) upgrade prompt and expired-session
            // (401/403) guidance as publish/validate, not a raw "Unexpected
            // error (HTTP …)". ReviseOutcome has no planLimit/blockers cases, so
            // those fold into .failed (see reviseOutcome(from:)).
            return reviseOutcome(from: error)
        } catch {
            return .failed(message: Self.networkFailureMessage(error))
        }
    }

    // MARK: - End listing

    func endListing(listingId: String) async -> PublishOutcome {
        let path = "/api/flipdesk/ebay/listings/\(listingId)"
        do {
            let response: EndListingResponse = try await sendJSON(
                path: path,
                method: "DELETE",
                body: Optional<EmptyBody>.none
            )
            return .ended(response)
        } catch let error as PublishHTTPError {
            return outcome(from: error)
        } catch {
            return .failed(message: Self.networkFailureMessage(error))
        }
    }

    // MARK: - Internals

    private struct EmptyBody: Encodable {}

    /// Friendly copy for a transport-layer failure (no HTTP status reached us).
    /// Classifies offline/DNS/timeout via ``FriendlyErrorCopy`` so the publish
    /// surfaces "you're offline" instead of a raw `URLError` string (US-1006);
    /// any other failure keeps its localized description.
    nonisolated static func networkFailureMessage(_ error: Error) -> String {
        FriendlyErrorCopy.isOffline(error)
            ? "You're offline. Check your connection and try again."
            : error.localizedDescription
    }

    /// 4xx/5xx that the typed PublishOutcome cases want to surface
    /// individually. We don't reuse EdgeAPIError because we need the
    /// raw status code AND the parsed body simultaneously.
    private struct PublishHTTPError: Error {
        let statusCode: Int
        let body: Data
    }

    /// US-1190: `revise()` returns ``ReviseOutcome``, which has no `planLimit`
    /// or `blockers` cases, so it can't reuse ``outcome(from:)`` (that returns
    /// ``PublishOutcome``). Map the shared HTTP statuses here — still firing the
    /// 402 upgrade prompt and giving 401/403 re-auth guidance — folding
    /// plan-limit / validation failures into `.failed`.
    /// US-1406: a 403 from the edge is not always an expired session. Reuse
    /// ``EdgeAPIError``'s body-discriminator decoding so an unconfirmed-email
    /// (`email_unverified`) or revoked-workspace (`workspace_access_revoked`) 403
    /// gets the right, recoverable guidance — telling a user with an unverified
    /// email to "sign in again" is a dead-end loop, since a fresh token is still
    /// unverified. Genuine 401/403s keep the re-auth guidance.
    private func authFailureMessage(_ error: PublishHTTPError) -> String {
        switch EdgeAPIError.from(statusCode: error.statusCode, body: error.body) {
        case .emailUnverified:
            return FriendlyErrorCopy.confirmEmailMessage
        case .workspaceAccessRevoked:
            return "You no longer have access to that workspace. Switch back to your own account, then retry publishing."
        default:
            return "Your session expired. Sign in again, then retry publishing."
        }
    }

    private func reviseOutcome(from error: PublishHTTPError) -> ReviseOutcome {
        switch error.statusCode {
        case 402:
            if let gate = PlanGateError.decode(from: error.body) {
                PlanGateNotifier.shared.present(gate)
            }
            return .failed(message: PlanGateBody.planLimitMessage(from: error.body))
        case 409:
            return .noOfferId
        case 401, 403:
            return .failed(message: authFailureMessage(error))
        default:
            let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: error.body)
            return .failed(message: parsed?.message ?? "Unexpected error (HTTP \(error.statusCode)).")
        }
    }

    private func outcome(from error: PublishHTTPError) -> PublishOutcome {
        switch error.statusCode {
        case 402:
            // Plan/usage cap (US-805/US-820) — surface friendly upgrade copy so
            // bulk callers can stop the run and prompt an upgrade instead of
            // hammering the same cap for every remaining draft. This client
            // doesn't flow through EdgeAPI's interceptor, so publish the decoded
            // cap to the shared notifier here too (US-805) — the root shell's
            // upgrade-prompt sheet de-dups, so the bulk banner + global prompt
            // coexist without double-presenting.
            if let gate = PlanGateError.decode(from: error.body) {
                PlanGateNotifier.shared.present(gate)
            }
            return .planLimit(message: PlanGateBody.planLimitMessage(from: error.body))
        case 422:
            // Blockers payload — caller renders them inline.
            if let parsed = try? JSONDecoder().decode(PushBlockersResponse.self, from: error.body) {
                return .blockers(parsed.blockers)
            }
            let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: error.body)
            return .failed(message: parsed?.message ?? "Validation failed.")
        case 409:
            return .noOfferId
        case 401, 403:
            // US-1163: an expired/!authorized session shouldn't read as a raw
            // "Unexpected error (HTTP 401)". US-1406: a 403 may instead be an
            // unconfirmed-email / revoked-workspace rejection — route to the
            // recoverable message rather than a re-auth loop.
            return .failed(message: authFailureMessage(error))
        default:
            let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: error.body)
            return .failed(message: parsed?.message ?? "Unexpected error (HTTP \(error.statusCode)).")
        }
    }

    private func postJSON<Response: Decodable, Body: Encodable>(
        path: String,
        body: Body
    ) async throws -> Response {
        try await sendJSON(path: path, method: "POST", body: body)
    }

    private func sendJSON<Response: Decodable, Body: Encodable>(
        path: String,
        method: String,
        body: Body?
    ) async throws -> Response {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = await SupabaseShared.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body, !(body is EmptyBody) {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw EdgeAPIError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw EdgeAPIError.network("Non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw PublishHTTPError(statusCode: http.statusCode, body: data)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}
