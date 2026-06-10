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

    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = .shared) {
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
            return .failed(message: error.localizedDescription)
        }
    }

    // MARK: - Push

    func push(inventoryItemId: String) async -> PublishOutcome {
        struct Body: Encodable { let inventory_item_id: String }
        do {
            let response: PushResponse = try await postJSON(
                path: "/api/flipdesk/ebay/listings/push",
                body: Body(inventory_item_id: inventoryItemId)
            )
            return .pushed(response)
        } catch let error as PublishHTTPError {
            return outcome(from: error)
        } catch {
            return .failed(message: error.localizedDescription)
        }
    }

    // MARK: - Price

    func updatePrice(listingId: String, price: Double) async -> PublishOutcome {
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
            return .failed(message: error.localizedDescription)
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
            if error.statusCode == 409 { return .noOfferId }
            let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: error.body)
            return .failed(message: parsed?.message ?? "Unexpected error (HTTP \(error.statusCode)).")
        } catch {
            return .failed(message: error.localizedDescription)
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
            return .failed(message: error.localizedDescription)
        }
    }

    // MARK: - Internals

    private struct EmptyBody: Encodable {}

    /// 4xx/5xx that the typed PublishOutcome cases want to surface
    /// individually. We don't reuse EdgeAPIError because we need the
    /// raw status code AND the parsed body simultaneously.
    private struct PublishHTTPError: Error {
        let statusCode: Int
        let body: Data
    }

    private func outcome(from error: PublishHTTPError) -> PublishOutcome {
        switch error.statusCode {
        case 422:
            // Blockers payload — caller renders them inline.
            if let parsed = try? JSONDecoder().decode(PushBlockersResponse.self, from: error.body) {
                return .blockers(parsed.blockers)
            }
            let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: error.body)
            return .failed(message: parsed?.message ?? "Validation failed.")
        case 409:
            return .noOfferId
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
