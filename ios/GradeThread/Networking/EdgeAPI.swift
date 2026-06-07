import Foundation

/// Thin async/await wrapper around `URLSession` for calling the Hono edge
/// service. Auto-attaches the current Supabase access token to every request
/// so callers don't have to remember.
///
/// `EdgeAPI` is an actor so the URLSession reference and the auth-token
/// provider can't race across concurrent calls. The shared instance lives in
/// ``shared`` and uses ``AppConfig/edgeAPIURL`` as its base.
public actor EdgeAPI {
    public static let shared = EdgeAPI(
        baseURL: AppConfig.edgeAPIURL,
        session: .shared,
        tokenProvider: { await SupabaseShared.currentAccessToken() }
    )

    private let baseURL: URL
    private let session: URLSession
    private let tokenProvider: @Sendable () async -> String?
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(
        baseURL: URL,
        session: URLSession,
        tokenProvider: @Sendable @escaping () async -> String?,
        decoder: JSONDecoder = .iso8601,
        encoder: JSONEncoder = .iso8601
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
        self.decoder = decoder
        self.encoder = encoder
    }

    // MARK: - Public

    public func getJSON<Response: Decodable>(
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> Response {
        try await perform(method: "GET", path: path, query: query, body: Optional<Empty>.none)
    }

    public func postJSON<Response: Decodable, Body: Encodable>(
        _ path: String,
        body: Body
    ) async throws -> Response {
        try await perform(method: "POST", path: path, body: body)
    }

    public func putJSON<Response: Decodable, Body: Encodable>(
        _ path: String,
        body: Body
    ) async throws -> Response {
        try await perform(method: "PUT", path: path, body: body)
    }

    public func deleteJSON<Response: Decodable>(_ path: String) async throws -> Response {
        try await perform(method: "DELETE", path: path, body: Optional<Empty>.none)
    }

    // MARK: - Internals

    private struct Empty: Encodable {}

    private func perform<Response: Decodable, Body: Encodable>(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Body?
    ) async throws -> Response {
        let request = try await buildRequest(method: method, path: path, query: query, body: body)

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
            throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }

    private func buildRequest<Body: Encodable>(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Body?
    ) async throws -> URLRequest {
        let url = try resolve(path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = await tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body, !(body is Empty) {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do {
                request.httpBody = try encoder.encode(body)
            } catch {
                throw EdgeAPIError.decoding("Request body encoding failed: \(error.localizedDescription)")
            }
        }

        return request
    }

    private func resolve(path: String, query: [URLQueryItem]) throws -> URL {
        // Allow callers to pass either `/foo` or `foo`; normalize to the
        // base URL's path semantics.
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent(trimmed),
            resolvingAgainstBaseURL: false
        ) else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        if !query.isEmpty {
            components.queryItems = query
        }
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        return url
    }
}

// MARK: - JSON helpers

public extension JSONDecoder {
    /// Matches the edge service which serializes timestamps as ISO 8601 with
    /// fractional seconds (Postgres `timestamptz` default).
    static let iso8601: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}

public extension JSONEncoder {
    static let iso8601: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.dateEncodingStrategy = .iso8601
        return e
    }()
}
