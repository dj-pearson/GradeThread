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

    /// US-638: bounded retry budget for transient failures (network / 5xx).
    private static let maxRetries = 2
    /// US-638: tiny in-memory TTL cache for idempotent GETs (comps, category
    /// suggest) keyed by method+path+query. Raw bytes are cached so each caller
    /// decodes into its own `Response` type.
    private var responseCache: [String: (data: Data, expires: Date)] = [:]

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

    /// `cacheTTL > 0` serves an idempotent GET from the in-memory cache when a
    /// fresh entry exists, and caches the response on success (US-638).
    public func getJSON<Response: Decodable>(
        _ path: String,
        query: [URLQueryItem] = [],
        cacheTTL: TimeInterval = 0
    ) async throws -> Response {
        try await perform(method: "GET", path: path, query: query, body: Optional<Empty>.none, cacheTTL: cacheTTL)
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
        body: Body?,
        cacheTTL: TimeInterval = 0
    ) async throws -> Response {
        let cacheKey = "\(method) \(path)?\(Self.canonicalQuery(query))"
        // Serve fresh idempotent GETs from cache (US-638).
        if cacheTTL > 0, method == "GET",
           let entry = responseCache[cacheKey], entry.expires > .now {
            if let cached = try? decoder.decode(Response.self, from: entry.data) {
                return cached
            }
        }

        let request = try await buildRequest(method: method, path: path, query: query, body: body)

        // Bounded retry-with-backoff for transient failures only (US-638);
        // 4xx (auth, bad request, not-found, rate-limit) fail fast.
        var attempt = 0
        while true {
            do {
                let (data, response): (Data, URLResponse)
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
                if cacheTTL > 0, method == "GET" {
                    responseCache[cacheKey] = (data, Date.now.addingTimeInterval(cacheTTL))
                }
                do {
                    return try decoder.decode(Response.self, from: data)
                } catch {
                    throw EdgeAPIError.decoding(error.localizedDescription)
                }
            } catch let error as EdgeAPIError {
                // US-794: membership in the active workspace was revoked — drop
                // the stale X-Workspace-Owner scope so the retry/next request
                // runs under the personal tenant, and notify the UI once. Then
                // surface the typed error to the caller.
                if case .workspaceAccessRevoked = error {
                    WorkspaceScope.handleAccessRevoked()
                    throw error
                }
                if Self.isTransient(error), attempt < Self.maxRetries {
                    try? await Task.sleep(nanoseconds: Backoff.delayNanos(attempt: attempt, base: 0.5, cap: 4))
                    attempt += 1
                    continue
                }
                throw error
            }
        }
    }

    /// Only network blips + 5xx are worth retrying — decode/4xx are deterministic.
    private static func isTransient(_ error: EdgeAPIError) -> Bool {
        switch error {
        case .network, .serverError: return true
        default: return false
        }
    }

    /// Stable cache key fragment: query items sorted so order doesn't matter.
    private static func canonicalQuery(_ query: [URLQueryItem]) -> String {
        query.map { "\($0.name)=\($0.value ?? "")" }.sorted().joined(separator: "&")
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

        // US-670: scope edge operations to the active workspace. Omitted when
        // personal (the edge workspace middleware defaults the tenant to the
        // caller); when set, the middleware validates the caller's membership
        // before honoring it.
        if let workspaceOwner = WorkspaceScope.activeOwnerId {
            request.setValue(workspaceOwner, forHTTPHeaderField: "X-Workspace-Owner")
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
