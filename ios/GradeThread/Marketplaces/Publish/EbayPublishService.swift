import Foundation

/// US-1508: the parameters of a Save & Sync revise, captured when the push can't
/// run offline and replayed on reconnect (after the item update lands). A plain
/// Sendable value type so it round-trips through the offline queue's JSON payload
/// and crosses the SyncEngine↔EbayPublishService actor boundary freely.
struct OfflineRevisePayload: Codable, Sendable {
    let listingId: String
    let title: String?
    let description: String?
    let price: Double?
    let resyncFields: Bool
    let conditionNoteChanged: Bool
    let conditionNote: String?
}

/// Wraps the four publish + manage endpoints behind a single Swift
/// surface. Each method returns a `PublishOutcome` rather than throwing
/// so callers can switch over the cases — the typed result includes
/// the 409 "no offer id" branch and the 422 "blockers" branch that the
/// raw `EdgeAPIError` would collapse together.
@MainActor
public final class EbayPublishService {

    private let baseURL: URL
    private let session: URLSession

    // Publish/revise/end are MULTI-HOP: the edge makes several eBay calls in a
    // row and streams nothing until the last one lands. The server allows 20s
    // PER HOP, so the 20s-idle `EdgeNetwork.shared` this used to sit on could
    // not survive one slow call, let alone five. See
    // `EdgeNetwork.marketplaceRequestTimeout`.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.marketplaceSession) {
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
            // One-shot: a timeout here says nothing about whether eBay created
            // the listing, so the copy must not invite a second attempt.
            return .failed(message: Self.networkFailureMessage(error, verb: .oneShot))
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
        quantity: Int? = nil,
        syncPhotos: Bool = false,
        resyncFields: Bool = false
    ) async -> ReviseOutcome {
        // Synthesized Encodable uses encodeIfPresent for optionals, so nil
        // fields are omitted from the body (the server treats missing as
        // "no change"). `photos` is sent only when a sync is requested.
        // US-1503: `resync_ebay_fields` forces the structured re-PUT (category/
        // condition/specifics/measurements/grade) so a measurement or column edit
        // reaches the live listing — web "Save & resubmit" parity (US-1490).
        // US-1973: `quantity` rides the same body — the server maps it onto the
        // offer's `availableQuantity` (updateOfferFields / bulkUpdatePriceQuantity),
        // where 0 means out of stock without withdrawing the offer.
        struct Body: Encodable {
            let title: String?
            let description: String?
            let listing_price: Double?
            let quantity: Int?
            let photos: Bool?
            let resync_ebay_fields: Bool?
        }
        let path = "/api/flipdesk/ebay/listings/\(listingId)/revise"
        do {
            let response: ReviseResponse = try await postJSON(
                path: path,
                body: Body(
                    title: title,
                    description: description,
                    listing_price: price,
                    quantity: quantity,
                    photos: syncPhotos ? true : nil,
                    resync_ebay_fields: resyncFields ? true : nil
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

    // MARK: - Quantity (US-1973)

    /// Sets the live listing's available quantity. `0` pulls it out of stock —
    /// the offer stays published (and relists in one tap) but nothing is
    /// buyable, which is what a seller wants for a temporarily unavailable item.
    /// Ending the listing outright is ``endListing(listingId:)``.
    func updateQuantity(listingId: String, quantity: Int) async -> ReviseOutcome {
        // The server rejects a negative quantity (400); catch it before the
        // round-trip so the control shows actionable copy, mirroring the
        // price guard in `updatePrice`.
        guard quantity >= 0 else {
            return .failed(message: "Enter a quantity of 0 or more.")
        }
        return await revise(listingId: listingId, quantity: quantity)
    }

    // MARK: - US-1508: offline Save & Sync revise replay

    /// Sendable result of an offline-queued revise replay, so the (non-MainActor)
    /// ``SyncEngine`` can map it to retry / stuck without holding a non-Sendable
    /// ``ReviseOutcome`` across the actor boundary.
    enum ReplayReviseResult: Sendable { case revised, noOfferId, failed(String) }

    /// Replays a queued Save & Sync revise (US-1508): mirrors the condition note
    /// onto the listing first (US-1501 parity), then revises. Runs on the MainActor
    /// (this service is `@MainActor`) and returns a Sendable result. `static` so the
    /// SyncEngine calls it with a single `await` hop instead of constructing a
    /// non-Sendable instance on the wrong actor.
    static func reviseForReplay(_ p: OfflineRevisePayload) async -> ReplayReviseResult {
        if p.conditionNoteChanged {
            do { try await mirrorConditionNote(listingId: p.listingId, note: p.conditionNote) }
            catch { return .failed("Couldn't update the eBay condition note.") }
        }
        switch await EbayPublishService().revise(
            listingId: p.listingId,
            title: p.title,
            description: p.description,
            price: p.price,
            syncPhotos: true,
            resyncFields: p.resyncFields
        ) {
        case .revised: return .revised
        case .noOfferId: return .noOfferId
        case .failed(let m): return .failed(m)
        }
    }

    /// US-1508/1501: writes the listing's canonical `ebay_condition_description`
    /// (explicit null to CLEAR) so a replayed revise carries the offline
    /// condition-note edit instead of the stale composer snapshot.
    private static func mirrorConditionNote(listingId: String, note: String?) async throws {
        struct Patch: Encodable {
            let ebay_condition_description: String?
            enum CodingKeys: String, CodingKey { case ebay_condition_description }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(ebay_condition_description, forKey: .ebay_condition_description)
            }
        }
        try await SupabaseShared.client
            .from("listings")
            .update(Patch(ebay_condition_description: note))
            .eq("id", value: listingId)
            .execute()
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
            // One-shot for the same reason as push: eBay may already have ended
            // it, and "try again" on an ended listing is its own confusion.
            return .failed(message: Self.networkFailureMessage(error, verb: .oneShot))
        }
    }

    // MARK: - Internals

    private struct EmptyBody: Encodable {}

    /// Whether this verb can safely be repeated after a failure that never
    /// reached us.
    ///
    /// Validate and price-update can: the first may not have run, and if it did,
    /// running it again lands on the same state. Publish, relist and end cannot
    /// — the edge records that a 5xx or timeout can arrive AFTER eBay has
    /// already acted (US-528), so a repeat is how one item becomes two live
    /// listings.
    enum Verb {
        case idempotent
        case oneShot
    }

    /// Friendly copy for a transport-layer failure (no HTTP status reached us).
    ///
    /// A TIMEOUT is separated from the rest, and the reason is worth stating.
    /// ``FriendlyErrorCopy/isOffline(_:)`` returns true for every
    /// `NSURLErrorDomain` code, timeouts included, so a publish that ran long
    /// used to report "You're offline. Check your connection and try again." on
    /// a connection that was fine, for work the server was still doing, and then
    /// invited the seller to do the one thing that duplicates a listing.
    ///
    /// A timeout tells us only that we stopped listening. It says nothing about
    /// whether eBay acted, so the copy must not imply either.
    // No trailing comma after the last parameter: Swift only allows that from
    // 6.1, and this target builds at SWIFT_VERSION 5.9.
    nonisolated static func networkFailureMessage(
        _ error: Error,
        verb: Verb = .idempotent
    ) -> String {
        if isTimeout(error) {
            return verb == .oneShot
                ? "This is taking longer than we can wait for. It may still have gone through, so check the listing on eBay before trying again."
                : "That took too long to answer. Check your connection and try again."
        }
        return FriendlyErrorCopy.isOffline(error)
            ? "You're offline. Check your connection and try again."
            : error.localizedDescription
    }

    /// True for a request that ran past its ceiling, at any depth in the error
    /// chain. Matched on the CODE, not the message, so it holds in every device
    /// language.
    nonisolated static func isTimeout(_ error: Error) -> Bool {
        var next: NSError? = error as NSError
        while let e = next {
            if e.domain == NSURLErrorDomain && e.code == NSURLErrorTimedOut { return true }
            next = e.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return false
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
