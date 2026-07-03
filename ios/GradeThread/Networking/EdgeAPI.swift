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
        // US-992: bounded-timeout session so a stalled request fails fast as
        // a transient `.network` error instead of hanging ~60s behind a spinner.
        session: EdgeNetwork.shared,
        // US-1523: a transient session-refresh failure throws a retryable
        // `.network` error — the request is NEVER sent unauthenticated and the
        // user NEVER sees "session expired" for a network blip.
        tokenProvider: { try await Self.resolveToken() },
        tokenRefresher: { try await Self.resolveRefreshedToken() }
    )

    /// US-1164: AI-session-backed instance so the slow vision calls (AI extract,
    /// Size AI) inherit the SAME transient retry/backoff, 401 token-refresh, and
    /// `X-Plan-Warning` / 402 plan-gate handling as the rest of the app — while
    /// keeping the long idle timeout those calls need (`EdgeNetwork.aiSession`
    /// vs. the 20s-idle `EdgeNetwork.shared`, which would falsely time out a
    /// 20-40s model pass). AI clients call ``sendRaw(method:path:query:bodyData:)``
    /// so their verbatim field-name response keys bypass the snake_case decoder.
    public static let aiShared = EdgeAPI(
        baseURL: AppConfig.edgeAPIURL,
        session: EdgeNetwork.aiSession,
        tokenProvider: { try await Self.resolveToken() },
        tokenRefresher: { try await Self.resolveRefreshedToken() }
    )

    /// US-1523: maps the typed token result onto the provider contract —
    /// `.token` attaches, `.noSession` proceeds unauthenticated (public
    /// endpoints), `.transient` throws the same retryable `.network` error the
    /// send loop already backs off on.
    private static func resolveToken() async throws -> String? {
        switch await SupabaseShared.currentAccessTokenResult() {
        case .token(let token): return token
        case .noSession: return nil
        case .transient(let why):
            throw EdgeAPIError.network("Session refresh failed: \(why)")
        }
    }

    /// US-1523: forced-refresh variant of ``resolveToken()`` — a transient
    /// refresh failure throws `.network` so a network blip during the one
    /// forced 401 refresh reads as "connection problem, retry", never
    /// "session expired". A definite no-session returns nil and the caller
    /// surfaces the original auth error (true expiry).
    private static func resolveRefreshedToken() async throws -> String? {
        switch await SupabaseShared.refreshAccessTokenResult() {
        case .token(let token): return token
        case .noSession: return nil
        case .transient(let why):
            throw EdgeAPIError.network("Session refresh failed: \(why)")
        }
    }

    private let baseURL: URL
    private let session: URLSession
    private let tokenProvider: @Sendable () async throws -> String?
    /// US-1146: forces a token refresh after a server 401 so a rejected-but-
    /// present token gets one explicit refresh + retry before surfacing
    /// "session expired". Injectable for tests.
    private let tokenRefresher: @Sendable () async throws -> String?
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    /// US-805: centralized plan-gate interception. A decoded 402 cap body and an
    /// 80% `X-Plan-Warning` header are published here so every flipdesk / grading
    /// / AI call surfaces an upgrade path without per-call wiring. Injectable so
    /// tests can capture the signal; defaults route to ``PlanGateNotifier``.
    private let onPlanGate: @Sendable (PlanGateError) -> Void
    private let onPlanWarning: @Sendable (PlanWarning) -> Void

    /// US-638: bounded retry budget for transient failures (network / 5xx).
    private static let maxRetries = 2

    /// US-995: hard caps on the in-memory response cache so paging many
    /// comps/categories can't grow it without bound. Eviction is LRU once
    /// either cap is exceeded; a blob larger than the byte cap is never cached.
    private static let cacheMaxEntries = 64
    private static let cacheMaxBytes = 4 * 1024 * 1024 // 4 MB

    private struct CacheEntry {
        let data: Data
        let expires: Date
        var lastAccess: UInt64
    }

    /// US-638/US-995: tiny in-memory TTL cache for idempotent GETs (comps,
    /// category suggest) keyed by method+path+query. Raw bytes are cached so
    /// each caller decodes into its own `Response` type. Bounded by
    /// ``cacheMaxEntries`` / ``cacheMaxBytes`` with LRU eviction (US-995).
    private var responseCache: [String: CacheEntry] = [:]
    /// Running total of cached `data` byte counts — kept in sync with
    /// ``responseCache`` so the byte cap is O(1) to enforce.
    private var responseCacheBytes = 0
    /// Monotonic tick stamped onto every read/write to order LRU eviction
    /// without relying on wall-clock time.
    private var cacheClock: UInt64 = 0

    // `internal` (not `public`): the `onPlanGate` / `onPlanWarning` parameters and
    // their `PlanGateNotifier` default values are app-internal types, which a
    // public initializer may not expose or reference in default args. This is a
    // single app module, so nothing outside it constructs `EdgeAPI` (the Tests
    // target uses `@testable import`), and `shared` stays the public entry point.
    init(
        baseURL: URL,
        session: URLSession,
        tokenProvider: @Sendable @escaping () async throws -> String?,
        tokenRefresher: @Sendable @escaping () async throws -> String? = { nil },
        decoder: JSONDecoder = .iso8601,
        encoder: JSONEncoder = .iso8601,
        onPlanGate: @escaping @Sendable (PlanGateError) -> Void = PlanGateNotifier.publish,
        onPlanWarning: @escaping @Sendable (PlanWarning) -> Void = PlanGateNotifier.publishWarning
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
        self.tokenRefresher = tokenRefresher
        self.decoder = decoder
        self.encoder = encoder
        self.onPlanGate = onPlanGate
        self.onPlanWarning = onPlanWarning
    }

    /// US-805: inspect a response for plan-gate signals — an 80% soft-warn
    /// header (any status) and a hard 402 cap body — and publish whatever's
    /// present. Pure side-effect; the caller still maps the status to its error.
    private func interceptPlanSignals(_ http: HTTPURLResponse, data: Data) {
        if let raw = http.value(forHTTPHeaderField: "X-Plan-Warning"),
           let warning = PlanWarning(header: raw) {
            onPlanWarning(warning)
        }
        if http.statusCode == 402, let gate = PlanGateError.decode(from: data) {
            onPlanGate(gate)
        }
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

    public func patchJSON<Response: Decodable, Body: Encodable>(
        _ path: String,
        body: Body
    ) async throws -> Response {
        try await perform(method: "PATCH", path: path, body: body)
    }

    public func deleteJSON<Response: Decodable>(_ path: String) async throws -> Response {
        try await perform(method: "DELETE", path: path, body: Optional<Empty>.none)
    }

    /// US-1164: runs an edge call through the shared transient-retry / backoff,
    /// 401-refresh, and plan-gate machinery while letting the caller own request
    /// body encoding AND response decoding. AI clients (extract, size) need this
    /// because their response keys (`brand`, `garment_category`, …) must be
    /// preserved verbatim and would be mangled by EdgeAPI's `.convertFromSnakeCase`
    /// decoder. `bodyData` is sent on the wire exactly as given (Content-Type
    /// `application/json` is set when non-nil). Returns the raw response bytes.
    public func sendRaw(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        bodyData: Data?
    ) async throws -> Data {
        try await performRaw(method: method, path: path, query: query, bodyData: bodyData)
    }

    /// US-1255: POSTs `bodyData` and returns the raw `(status, body)` so the
    /// caller can read a domain-specific `error_code`/reason out of a 4xx body —
    /// detail the typed `EdgeAPIError` mapping collapses (e.g. a 403 becomes the
    /// generic `.unauthorized`). Goes through the same request build + plan-gate
    /// interception as the typed helpers, but skips the retry/refresh loop: the
    /// lone caller (referral redeem) is a rare manual action the user can retry,
    /// and a thrown error here would discard exactly the reason we need. Throws
    /// only on a transport failure (no HTTP response).
    public func postForStatus(
        _ path: String,
        bodyData: Data
    ) async throws -> (status: Int, body: Data) {
        let request = try await buildRequest(method: "POST", path: path, query: [], bodyData: bodyData)
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
        interceptPlanSignals(http, data: data)
        return (http.statusCode, data)
    }

    /// POSTs a single image part (plus optional string fields) as
    /// `multipart/form-data`. Used for eBay payment-dispute evidence uploads
    /// (US-1049). Not retried for transient network/5xx (uploads aren't
    /// idempotent), but it DOES perform the same single forced token-refresh on
    /// a rejected token (401/403) as ``performRaw`` (US-1146/US-1252) — a
    /// present-but-stale token gets one explicit refresh + rebuilt request
    /// before surfacing "session expired", so a queued evidence/photo upload
    /// isn't dead-ended mid-task.
    public func postMultipartImage<Response: Decodable>(
        _ path: String,
        fieldName: String,
        fileName: String,
        mimeType: String,
        data: Data,
        fields: [String: String] = [:]
    ) async throws -> Response {
        // The multipart body is token-independent, so build it ONCE and reuse
        // the bytes across the single 401-refresh retry; only the request (which
        // carries the bearer token) is rebuilt with the fresh token (US-1252).
        let boundary = "Boundary-\(UUID().uuidString)"
        let body = Self.multipartBody(
            boundary: boundary, fieldName: fieldName, fileName: fileName,
            mimeType: mimeType, data: data, fields: fields)

        var request = try await buildMultipartRequest(path: path, boundary: boundary)

        // US-1252: allow exactly one forced token refresh + retry on a 401/403.
        // The single auth rebuild is safe even though uploads aren't idempotent
        // — a rejected token means the request never reached server-side logic.
        var didRefreshAuth = false
        while true {
            let (respData, response): (Data, URLResponse)
            do {
                (respData, response) = try await session.upload(for: request, from: body)
            } catch {
                throw EdgeAPIError.network(error.localizedDescription)
            }
            guard let http = response as? HTTPURLResponse else {
                throw EdgeAPIError.network("Non-HTTP response")
            }
            interceptPlanSignals(http, data: respData)
            guard (200..<300).contains(http.statusCode) else {
                let mapped = EdgeAPIError.from(statusCode: http.statusCode, body: respData)
                if case .unauthorized = mapped, !didRefreshAuth {
                    didRefreshAuth = true
                    if try await tokenRefresher() != nil {
                        request = try await buildMultipartRequest(path: path, boundary: boundary)
                        continue
                    }
                }
                throw mapped
            }
            do {
                return try decoder.decode(Response.self, from: respData)
            } catch {
                throw EdgeAPIError.decoding(error.localizedDescription)
            }
        }
    }

    /// Builds the `multipart/form-data` request for ``postMultipartImage``,
    /// attaching the current auth token + active-workspace scope. Separated so a
    /// forced 401-refresh can rebuild it with a freshly-minted token (US-1252).
    private func buildMultipartRequest(path: String, boundary: String) async throws -> URLRequest {
        let url = try resolve(path: path, query: [])
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = try await tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let workspaceOwner = WorkspaceScope.activeOwnerId {
            request.setValue(workspaceOwner, forHTTPHeaderField: "X-Workspace-Owner")
        }
        request.setValue(
            "multipart/form-data; boundary=\(boundary)",
            forHTTPHeaderField: "Content-Type"
        )
        return request
    }

    /// Encodes the multipart body for a single image part plus optional string
    /// fields. `static` (token-independent) so it's built once and reused across
    /// the 401-refresh retry without re-serializing the image bytes (US-1252).
    private static func multipartBody(
        boundary: String,
        fieldName: String,
        fileName: String,
        mimeType: String,
        data: Data,
        fields: [String: String]
    ) -> Data {
        var body = Data()
        func append(_ string: String) {
            body.append(Data(string.utf8))
        }
        for (key, value) in fields {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n")
            append("\(value)\r\n")
        }
        append("--\(boundary)\r\n")
        append(
            "Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(fileName)\"\r\n"
        )
        append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(data)
        append("\r\n")
        append("--\(boundary)--\r\n")
        return body
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
        // Encode the typed body once up front; `performRaw` reuses the bytes
        // across retries and the 401-refresh rebuild. The retry/refresh/plan-gate
        // loop lives in `performRaw` (US-1164) so AI clients can share it via
        // `sendRaw` while decoding with their own verbatim-key decoder.
        let bodyData = try encodeBody(body)
        let data = try await performRaw(
            method: method, path: path, query: query, bodyData: bodyData, cacheTTL: cacheTTL)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }

    /// Encodes a typed request body to JSON, treating nil / the ``Empty``
    /// sentinel as "no body". Throws a typed `.decoding` error on failure.
    private func encodeBody<Body: Encodable>(_ body: Body?) throws -> Data? {
        guard let body, !(body is Empty) else { return nil }
        do {
            return try encoder.encode(body)
        } catch {
            throw EdgeAPIError.decoding("Request body encoding failed: \(error.localizedDescription)")
        }
    }

    /// The shared request loop: cache, transient retry/backoff, one forced
    /// 401-refresh, and plan-gate interception — returning the raw response
    /// bytes. Both the typed ``perform`` and the raw ``sendRaw`` route through
    /// here so AI clients inherit identical resilience (US-1164).
    private func performRaw(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        bodyData: Data?,
        cacheTTL: TimeInterval = 0
    ) async throws -> Data {
        let cacheKey = "\(method) \(path)?\(Self.canonicalQuery(query))"
        // Serve fresh idempotent GETs from cache (US-638).
        if cacheTTL > 0, method == "GET", let cached = cacheLookup(cacheKey) {
            return cached
        }

        var request = try await buildRequest(method: method, path: path, query: query, bodyData: bodyData)

        // Bounded retry-with-backoff for transient failures only (US-638);
        // network/5xx + 429 rate-limits retry (US-1145), other 4xx fail fast.
        var attempt = 0
        // US-1146: allow exactly one forced token refresh + retry on a 401/403.
        var didRefreshAuth = false
        // US-1145: when a 429 carries a `Retry-After`, honor it for the next
        // backoff instead of the blind exponential schedule. Reset after use.
        var retryAfterHint: TimeInterval?
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
                interceptPlanSignals(http, data: data)
                guard (200..<300).contains(http.statusCode) else {
                    if http.statusCode == 429 {
                        // US-1145: surface rate-limit frequency to Sentry and
                        // capture the server's backoff hint for the retry.
                        retryAfterHint = Self.parseRetryAfter(
                            http.value(forHTTPHeaderField: "Retry-After"))
                        Telemetry.backgroundBreadcrumb(
                            "Edge 429 rate-limited [\(method) \(path)]"
                                + (retryAfterHint.map { " retryAfter=\(Int($0))s" } ?? ""),
                            category: "network")
                        // US-1253: carry the Retry-After hint on the error so a
                        // caller that exhausts retries can show "try again in Ns".
                        throw EdgeAPIError.rateLimited(retryAfter: retryAfterHint)
                    }
                    throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
                }
                if cacheTTL > 0, method == "GET" {
                    cacheStore(cacheKey, data: data, ttl: cacheTTL)
                }
                return data
            } catch let error as EdgeAPIError {
                // US-794: membership in the active workspace was revoked — drop
                // the stale X-Workspace-Owner scope so the retry/next request
                // runs under the personal tenant, and notify the UI once. Then
                // surface the typed error to the caller.
                if case .workspaceAccessRevoked = error {
                    WorkspaceScope.handleAccessRevoked()
                    throw error
                }
                // US-1146: one forced token refresh + retry before surfacing an
                // auth failure. The SDK refreshes near-expiry on its own, but a
                // token the server actively rejects (rotation, clock skew) needs
                // an explicit refresh — rebuilding the request re-attaches the
                // fresh token — rather than dead-ending the user on "session
                // expired" mid-task.
                if case .unauthorized = error, !didRefreshAuth {
                    didRefreshAuth = true
                    if try await tokenRefresher() != nil {
                        request = try await buildRequest(
                            method: method, path: path, query: query, bodyData: bodyData)
                        continue
                    }
                    throw error
                }
                if Self.shouldRetry(error, method: method), attempt < Self.maxRetries {
                    // Honor a `Retry-After` hint (capped) for a 429; otherwise
                    // fall back to the bounded exponential backoff.
                    let nanos: UInt64
                    if let hint = retryAfterHint {
                        nanos = UInt64(min(max(hint, 0), 8) * 1_000_000_000)
                        retryAfterHint = nil
                    } else {
                        nanos = Backoff.delayNanos(attempt: attempt, base: 0.5, cap: 4)
                    }
                    try? await Task.sleep(nanoseconds: nanos)
                    attempt += 1
                    continue
                }
                throw error
            }
        }
    }

    /// Network blips, 5xx, and 429 rate-limits are worth retrying — a 429 means
    /// the request was rejected (not processed), so retrying is safe even for
    /// writes. Decode + other 4xx are deterministic and fail fast (US-1145).
    static func isTransient(_ error: EdgeAPIError) -> Bool {
        switch error {
        case .network, .serverError, .rateLimited: return true
        default: return false
        }
    }

    /// US-1164: which transient errors are safe to retry for a given HTTP method.
    /// A 5xx on a non-idempotent POST/PATCH may have been applied server-side
    /// before the failure, so blind-retrying risks a duplicate sale/listing — we
    /// retry 5xx only for idempotent methods. Network blips and 429 (rejected,
    /// not processed) remain retryable for any method.
    static func shouldRetry(_ error: EdgeAPIError, method: String) -> Bool {
        switch error {
        case .network, .rateLimited: return true
        case .serverError: return isIdempotent(method)
        default: return false
        }
    }

    static func isIdempotent(_ method: String) -> Bool {
        switch method.uppercased() {
        case "GET", "HEAD", "PUT", "DELETE", "OPTIONS": return true
        default: return false // POST, PATCH
        }
    }

    /// Parse an HTTP `Retry-After` header. Supports the delay-seconds form
    /// (e.g. "30"); the HTTP-date form is ignored (returns nil) and the caller
    /// falls back to exponential backoff. `internal` so it's unit-testable
    /// (US-1145).
    static func parseRetryAfter(_ value: String?) -> TimeInterval? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        // `Double("nan")` / `Double("inf")` parse successfully — a malformed or
        // hostile `Retry-After: inf` would otherwise flow into `Int($0)` (the
        // breadcrumb) and `UInt64(...)` (the sleep), both of which TRAP on a
        // non-finite value. Only accept finite seconds; fall through otherwise.
        if let seconds = Double(value), seconds.isFinite { return max(0, seconds) }
        // US-1164: also accept the HTTP-date form (RFC 1123), converting it to a
        // relative delay from now (clamped to >= 0). The caller caps the result.
        if let date = httpDateFormatter.date(from: value) {
            return max(0, date.timeIntervalSinceNow)
        }
        return nil
    }

    private static let httpDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return f
    }()

    /// Stable cache key fragment: query items sorted so order doesn't matter.
    private static func canonicalQuery(_ query: [URLQueryItem]) -> String {
        query.map { "\($0.name)=\($0.value ?? "")" }.sorted().joined(separator: "&")
    }

    // MARK: - Response cache (US-995)

    /// Returns the cached bytes for `key` when a fresh entry exists, refreshing
    /// its LRU stamp. Expired entries are removed eagerly (not just skipped).
    private func cacheLookup(_ key: String) -> Data? {
        guard let entry = responseCache[key] else { return nil }
        guard entry.expires > .now else {
            removeCacheEntry(key)
            return nil
        }
        cacheClock &+= 1
        responseCache[key]?.lastAccess = cacheClock
        return entry.data
    }

    /// Inserts `data` under `key` and enforces the entry/byte caps, evicting the
    /// least-recently-used entries (and any encountered expired ones) so the
    /// cache can never grow without bound. Blobs larger than the byte cap are
    /// not cached at all (caching one would force every other entry out).
    private func cacheStore(_ key: String, data: Data, ttl: TimeInterval) {
        purgeExpiredCacheEntries()
        removeCacheEntry(key) // replace any prior entry's byte accounting

        guard data.count <= Self.cacheMaxBytes else { return }

        cacheClock &+= 1
        responseCache[key] = CacheEntry(
            data: data,
            expires: Date.now.addingTimeInterval(ttl),
            lastAccess: cacheClock
        )
        responseCacheBytes += data.count

        evictUntilWithinCaps()
    }

    /// Drops expired entries up front so they don't count toward the caps.
    private func purgeExpiredCacheEntries() {
        let now = Date.now
        let expired = responseCache.compactMap { $0.value.expires <= now ? $0.key : nil }
        for key in expired { removeCacheEntry(key) }
    }

    /// Evicts the least-recently-used entry until both caps are satisfied.
    private func evictUntilWithinCaps() {
        guard responseCache.count > Self.cacheMaxEntries
            || responseCacheBytes > Self.cacheMaxBytes else { return }
        // US-1166: sort by recency once and drop the oldest prefix, instead of
        // an O(n) min() per evicted entry (O(n^2) when many must be dropped).
        let oldestFirst = responseCache.sorted { $0.value.lastAccess < $1.value.lastAccess }
        var index = 0
        while (responseCache.count > Self.cacheMaxEntries
            || responseCacheBytes > Self.cacheMaxBytes),
            index < oldestFirst.count {
            removeCacheEntry(oldestFirst[index].key)
            index += 1
        }
    }

    /// Removes one entry and keeps the running byte total in sync.
    private func removeCacheEntry(_ key: String) {
        if let removed = responseCache.removeValue(forKey: key) {
            responseCacheBytes -= removed.data.count
        }
    }

    /// Test-only introspection of the bounded response cache (US-995): current
    /// entry count, total cached bytes, and the enforced caps.
    public func cacheStatsForTesting() -> (entries: Int, bytes: Int, maxEntries: Int, maxBytes: Int) {
        (responseCache.count, responseCacheBytes, Self.cacheMaxEntries, Self.cacheMaxBytes)
    }

    private func buildRequest(
        method: String,
        path: String,
        query: [URLQueryItem],
        bodyData: Data?
    ) async throws -> URLRequest {
        let url = try resolve(path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = try await tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        // US-670: scope edge operations to the active workspace. Omitted when
        // personal (the edge workspace middleware defaults the tenant to the
        // caller); when set, the middleware validates the caller's membership
        // before honoring it.
        if let workspaceOwner = WorkspaceScope.activeOwnerId {
            request.setValue(workspaceOwner, forHTTPHeaderField: "X-Workspace-Owner")
        }

        if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
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
