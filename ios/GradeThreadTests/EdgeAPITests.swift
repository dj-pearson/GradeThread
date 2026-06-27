import XCTest
@testable import GradeThread

/// Hermetic tests for ``EdgeAPI`` using a custom `URLProtocol` to intercept
/// every request. No real network is hit; no shared state leaks between
/// tests because each XCTestCase gets a fresh URLSession configuration.
final class EdgeAPITests: XCTestCase {

    // MARK: - Fixtures

    private struct CreateItem: Codable {
        let title: String
    }

    private func makeAPI(
        token: String? = "tk_test",
        tokenRefresher: @escaping @Sendable () async -> String? = { nil }
    ) -> EdgeAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        return EdgeAPI(
            baseURL: URL(string: "https://example.test")!,
            session: session,
            tokenProvider: { token },
            tokenRefresher: tokenRefresher
        )
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - Happy paths

    func test_getJSON_decodesResponse_andAttachesAuthHeader() async throws {
        let json = #"""
        {"id":"abc","title":"Linen blazer","created_at":"2026-05-27T12:34:56Z"}
        """#
        var observedHeaders: [String: String] = [:]
        MockURLProtocol.handler = { request in
            observedHeaders = request.allHTTPHeaderFields ?? [:]
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(json.utf8)
            )
        }

        let api = makeAPI(token: "tk_abc")
        let item: Item = try await api.getJSON("/api/v1/items/abc")

        XCTAssertEqual(item.id, "abc")
        XCTAssertEqual(item.title, "Linen blazer")
        XCTAssertEqual(observedHeaders["Authorization"], "Bearer tk_abc")
        XCTAssertEqual(observedHeaders["Accept"], "application/json")
    }

    func test_postJSON_encodesBodyAsSnakeCase() async throws {
        var observedBody: Data?
        MockURLProtocol.handler = { request in
            // The mock receives the request *after* URLSession converts
            // httpBody to httpBodyStream when run through a protocol.
            // Capture either form.
            observedBody = request.httpBody ?? Self.readStream(request)
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 201,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"{"id":"new","title":"Hat","created_at":"2026-05-27T00:00:00Z"}"#.utf8)
            )
        }

        let api = makeAPI()
        let created: Item = try await api.postJSON("/api/v1/items", body: CreateItem(title: "Hat"))
        XCTAssertEqual(created.id, "new")

        let body = try XCTUnwrap(observedBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["title"] as? String, "Hat")
    }

    func test_tokenProviderReturnsNil_omitsAuthorizationHeader() async throws {
        var observedHeaders: [String: String] = [:]
        MockURLProtocol.handler = { request in
            observedHeaders = request.allHTTPHeaderFields ?? [:]
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                Data("{\"id\":\"x\",\"title\":\"y\",\"created_at\":\"2026-01-01T00:00:00Z\"}".utf8)
            )
        }
        let api = makeAPI(token: nil)
        let _: Item = try await api.getJSON("/api/v1/items/x")
        XCTAssertNil(observedHeaders["Authorization"])
    }

    // MARK: - Error mapping

    func test_401_mapsToUnauthorized() async {
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!,
                Data("{\"error\":\"jwt expired\"}".utf8)
            )
        }
        await XCTAssertThrowsItem(.unauthorized, with: makeAPI())
    }

    func test_429_mapsToRateLimited() async {
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: nil)!,
                Data()
            )
        }
        await XCTAssertThrowsItem(.rateLimited(), with: makeAPI())
    }

    // US-1253: the 429 `Retry-After` hint is carried on the error so the UI can
    // show a concrete "try again in Ns" instead of a vague "in a moment".
    func test_rateLimited_errorDescription_surfacesRetryAfterSeconds() {
        XCTAssertEqual(
            EdgeAPIError.rateLimited(retryAfter: 5).errorDescription,
            "You're going a little too fast. Try again in 5s.")
        // A sub-second / zero hint and a missing hint both fall back to the
        // vague copy (no "0s").
        XCTAssertEqual(
            EdgeAPIError.rateLimited(retryAfter: nil).errorDescription,
            "You're going a little too fast. Try again in a moment.")
        XCTAssertEqual(
            EdgeAPIError.rateLimited(retryAfter: 0).errorDescription,
            "You're going a little too fast. Try again in a moment.")
    }

    // US-1145: a 429 is transient — it retries and succeeds when the next
    // attempt is allowed through (the request was rejected, not processed, so a
    // retry is safe).
    func test_429_thenSuccess_retriesAndSucceeds() async throws {
        let json = #"{"id":"r1","title":"Retried","created_at":"2026-05-27T12:34:56Z"}"#
        let calls = CallBox()
        MockURLProtocol.handler = { request in
            let n = calls.next()
            if n == 1 {
                return (
                    HTTPURLResponse(
                        url: request.url!, statusCode: 429, httpVersion: nil,
                        headerFields: ["Retry-After": "0"])!,
                    Data())
            }
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                Data(json.utf8))
        }
        let item: Item = try await makeAPI().getJSON("/foo")
        XCTAssertEqual(item.id, "r1")
        XCTAssertEqual(calls.count, 2)  // one 429, one success
    }

    func test_parseRetryAfter_secondsForm() {
        XCTAssertEqual(EdgeAPI.parseRetryAfter("30"), 30)
        XCTAssertEqual(EdgeAPI.parseRetryAfter("  5 "), 5)
        XCTAssertEqual(EdgeAPI.parseRetryAfter("0"), 0)
    }

    func test_parseRetryAfter_rejectsNonNumericAndNil() {
        XCTAssertNil(EdgeAPI.parseRetryAfter(nil))
        XCTAssertNil(EdgeAPI.parseRetryAfter(""))
        XCTAssertNil(EdgeAPI.parseRetryAfter("soon"))
    }

    // `Double("inf")` / `Double("nan")` parse successfully; if accepted they
    // would flow into `Int(...)` (breadcrumb) and `UInt64(...)` (sleep), both of
    // which TRAP on a non-finite value. A hostile/buggy server must not crash us.
    func test_parseRetryAfter_rejectsNonFinite() {
        XCTAssertNil(EdgeAPI.parseRetryAfter("inf"))
        XCTAssertNil(EdgeAPI.parseRetryAfter("-inf"))
        XCTAssertNil(EdgeAPI.parseRetryAfter("nan"))
        XCTAssertNil(EdgeAPI.parseRetryAfter("Infinity"))
    }

    // US-1164: the HTTP-date form is now honored, converted to a relative delay.
    func test_parseRetryAfter_httpDateForm() {
        // A future GMT date → a positive delay (the caller caps it).
        let future = Date().addingTimeInterval(120)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        let value = formatter.string(from: future)
        let parsed = EdgeAPI.parseRetryAfter(value)
        XCTAssertNotNil(parsed)
        XCTAssertGreaterThan(parsed ?? 0, 60)
        // A past date clamps to 0 (never negative).
        XCTAssertEqual(EdgeAPI.parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"), 0)
    }

    func test_isTransient_includesRateLimitedNotBadRequest() {
        XCTAssertTrue(EdgeAPI.isTransient(.rateLimited()))
        XCTAssertTrue(EdgeAPI.isTransient(.network("x")))
        XCTAssertTrue(EdgeAPI.isTransient(.serverError(detail: nil)))
        XCTAssertFalse(EdgeAPI.isTransient(.badRequest(detail: nil)))
        XCTAssertFalse(EdgeAPI.isTransient(.unauthorized))
    }

    // US-1164: a 5xx on a non-idempotent POST/PATCH must NOT be retried (it may
    // already have been applied → duplicate sale/listing); 429 + network still
    // retry for any method, and idempotent methods still retry 5xx.
    func test_shouldRetry_does_not_retry_5xx_on_POST() {
        XCTAssertFalse(EdgeAPI.shouldRetry(.serverError(detail: nil), method: "POST"))
        XCTAssertFalse(EdgeAPI.shouldRetry(.serverError(detail: nil), method: "PATCH"))
        XCTAssertTrue(EdgeAPI.shouldRetry(.serverError(detail: nil), method: "PUT"))
        XCTAssertTrue(EdgeAPI.shouldRetry(.serverError(detail: nil), method: "GET"))
        XCTAssertTrue(EdgeAPI.shouldRetry(.serverError(detail: nil), method: "DELETE"))
        // Rejected-not-processed + network blips retry for any method.
        XCTAssertTrue(EdgeAPI.shouldRetry(.rateLimited(), method: "POST"))
        XCTAssertTrue(EdgeAPI.shouldRetry(.network("x"), method: "POST"))
        XCTAssertFalse(EdgeAPI.shouldRetry(.badRequest(detail: nil), method: "POST"))
    }

    // US-1146: a 401 triggers exactly one forced refresh + retry; if the retry
    // succeeds the call returns rather than surfacing "session expired".
    func test_401_refreshesTokenAndRetriesOnce() async throws {
        let json = #"{"id":"ok","title":"After refresh","created_at":"2026-05-27T12:34:56Z"}"#
        let calls = CallBox()
        let refreshes = CallBox()
        MockURLProtocol.handler = { request in
            let n = calls.next()
            if n == 1 {
                return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data())
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
        }
        let api = makeAPI(tokenRefresher: { _ = refreshes.next(); return "fresh_token" })
        let item: Item = try await api.getJSON("/foo")
        XCTAssertEqual(item.id, "ok")
        XCTAssertEqual(refreshes.count, 1)   // refreshed exactly once
        XCTAssertEqual(calls.count, 2)       // 401 then success
    }

    // When the refresh can't produce a token, the 401 surfaces (no infinite loop).
    func test_401_refreshFails_surfacesUnauthorized() async {
        let calls = CallBox()
        MockURLProtocol.handler = { request in
            _ = calls.next()
            return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data())
        }
        let api = makeAPI(tokenRefresher: { nil })
        await XCTAssertThrowsItem(.unauthorized, with: api)
        XCTAssertEqual(calls.count, 1)       // no retry when refresh yields nothing
    }

    // US-1164: a 5xx on a non-idempotent POST is attempted EXACTLY ONCE — no
    // blind retry that could double-apply a write the server already committed.
    func test_500_on_POST_isNotRetried() async {
        let calls = CallBox()
        MockURLProtocol.handler = { request in
            _ = calls.next()
            return (
                HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!,
                Data(#"{"error":"boom"}"#.utf8))
        }
        let api = makeAPI()
        do {
            let _: Item = try await api.postJSON("/api/v1/items", body: CreateItem(title: "x"))
            XCTFail("Expected serverError")
        } catch let error as EdgeAPIError {
            guard case .serverError = error else { return XCTFail("Expected .serverError, got \(error)") }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(calls.count, 1, "POST 5xx must not be retried")
    }

    // A 5xx on an idempotent GET still retries through the bounded budget
    // (1 initial + maxRetries) — the resilience AI clients now inherit too.
    func test_500_on_GET_isRetried() async {
        let calls = CallBox()
        MockURLProtocol.handler = { request in
            _ = calls.next()
            return (
                HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!,
                Data(#"{"error":"boom"}"#.utf8))
        }
        let api = makeAPI()
        do {
            let _: Item = try await api.getJSON("/foo")
            XCTFail("Expected serverError")
        } catch let error as EdgeAPIError {
            guard case .serverError = error else { return XCTFail("Expected .serverError, got \(error)") }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(calls.count, 3, "GET 5xx should retry the full bounded budget (1 + 2)")
    }

    // MARK: - sendRaw (US-1164: AI clients share the resilient loop)

    /// `sendRaw` runs the shared request loop — attaching auth, returning the raw
    /// response bytes verbatim — so AI clients inherit retry/refresh/plan-gate
    /// without EdgeAPI's snake_case decoder touching their field-name keys.
    func test_sendRaw_attachesAuth_andReturnsRawBytesVerbatim() async throws {
        var observed: [String: String] = [:]
        // Snake_case keys that EdgeAPI's decoder would mangle — must come back
        // untouched through sendRaw.
        let raw = #"{"garment_category":"jacket","brand":"Patagonia"}"#
        MockURLProtocol.handler = { request in
            observed = request.allHTTPHeaderFields ?? [:]
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"])!,
                Data(raw.utf8))
        }
        let api = makeAPI(token: "tk_ai")
        let data = try await api.sendRaw(
            method: "POST", path: "/api/flipdesk/ai/extract",
            bodyData: Data(#"{"item_id":"i"}"#.utf8))
        XCTAssertEqual(String(decoding: data, as: UTF8.self), raw)
        XCTAssertEqual(observed["Authorization"], "Bearer tk_ai")
        XCTAssertEqual(observed["Content-Type"], "application/json")
    }

    /// A 401 on a `sendRaw` POST forces exactly one token refresh + retry, just
    /// like the typed path — so an AI extract doesn't dead-end on a stale token.
    func test_sendRaw_401_refreshesAndRetriesOnce() async throws {
        let calls = CallBox()
        let refreshes = CallBox()
        MockURLProtocol.handler = { request in
            let n = calls.next()
            if n == 1 {
                return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data())
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        let api = makeAPI(tokenRefresher: { _ = refreshes.next(); return "fresh" })
        let data = try await api.sendRaw(method: "POST", path: "/foo", bodyData: Data("{}".utf8))
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "{}")
        XCTAssertEqual(refreshes.count, 1)
        XCTAssertEqual(calls.count, 2)
    }

    // MARK: - postMultipartImage auth refresh (US-1252)

    /// A multipart image upload performs the SAME single forced token-refresh on
    /// a 401 as the JSON/raw paths (US-1146): the first attempt's stale token is
    /// rejected, the client refreshes once, rebuilds the multipart request with
    /// the fresh token, and the retry succeeds — instead of dead-ending the
    /// queued upload on "session expired".
    func test_postMultipartImage_401_refreshesTokenAndRetriesOnce() async throws {
        let calls = CallBox()
        let refreshes = CallBox()
        let observedAuth = AuthBox()
        MockURLProtocol.handler = { request in
            let n = calls.next()
            observedAuth.record(request.value(forHTTPHeaderField: "Authorization"))
            if n == 1 {
                return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data())
            }
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"])!,
                Data(#"{"ok":true}"#.utf8))
        }
        let api = makeAPI(token: "stale", tokenRefresher: { _ = refreshes.next(); return "fresh_token" })
        struct Ack: Decodable { let ok: Bool }
        let ack: Ack = try await api.postMultipartImage(
            "/api/flipdesk/disputes/evidence",
            fieldName: "file", fileName: "e.jpg", mimeType: "image/jpeg",
            data: Data([0xFF, 0xD8, 0xFF]),
            fields: ["dispute_id": "d1"])
        XCTAssertTrue(ack.ok)
        XCTAssertEqual(refreshes.count, 1)             // refreshed exactly once
        XCTAssertEqual(calls.count, 2)                 // 401 then success
        XCTAssertEqual(observedAuth.first, "Bearer stale")
        XCTAssertEqual(observedAuth.last, "Bearer fresh_token", "retry must carry the refreshed token")
    }

    /// When the refresh can't mint a token, the 401 surfaces (no retry, no loop).
    func test_postMultipartImage_401_refreshFails_surfacesUnauthorized() async {
        let calls = CallBox()
        MockURLProtocol.handler = { request in
            _ = calls.next()
            return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data())
        }
        let api = makeAPI(tokenRefresher: { nil })
        struct Ack: Decodable { let ok: Bool }
        do {
            let _: Ack = try await api.postMultipartImage(
                "/api/flipdesk/disputes/evidence",
                fieldName: "file", fileName: "e.jpg", mimeType: "image/jpeg",
                data: Data([0xFF]))
            XCTFail("Expected unauthorized")
        } catch let error as EdgeAPIError {
            XCTAssertEqual(error, .unauthorized)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(calls.count, 1, "no retry when refresh yields nothing")
    }

    func test_400_mapsToBadRequest_withDetail() async {
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!,
                Data("{\"error\":\"validation_failed\",\"detail\":\"tier is required\"}".utf8)
            )
        }
        await XCTAssertThrowsItem(.badRequest(detail: "tier is required"), with: makeAPI())
    }

    func test_500_mapsToServerError() async {
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!,
                Data("{\"error\":\"boom\"}".utf8)
            )
        }
        await XCTAssertThrowsItem(.serverError(detail: "boom"), with: makeAPI())
    }

    // US-794: a 403 carrying the workspace_access_revoked code maps to its own
    // case (so the client clears the stale scope), while a plain 403 still maps
    // to .unauthorized. Tests the pure mapper directly — no network/side effects.
    func test_403_withWorkspaceRevokedCode_mapsToWorkspaceAccessRevoked() {
        let body = Data(
            #"{"error":"You don't have access to this workspace","error_code":"workspace_access_revoked"}"#
                .utf8
        )
        XCTAssertEqual(EdgeAPIError.from(statusCode: 403, body: body), .workspaceAccessRevoked)
    }

    func test_403_withoutCode_stillMapsToUnauthorized() {
        let body = Data(#"{"error":"forbidden"}"#.utf8)
        XCTAssertEqual(EdgeAPIError.from(statusCode: 403, body: body), .unauthorized)
    }

    // US-1182: the auth middleware's unconfirmed-email 403 uses the short `code`
    // key and must map to its own `.emailUnverified` case (actionable message,
    // no pointless token refresh), not the generic session-expired `.unauthorized`.
    func test_403_emailUnverified_mapsToEmailUnverified() {
        let body = Data(
            #"{"error":"Email not verified. Please confirm your email to continue.","code":"email_unverified"}"#
                .utf8
        )
        XCTAssertEqual(EdgeAPIError.from(statusCode: 403, body: body), .emailUnverified)
        XCTAssertNotEqual(EdgeAPIError.emailUnverified, .unauthorized)
    }

    func test_networkFailure_mapsToNetwork() async {
        MockURLProtocol.handler = { _ in
            throw URLError(.notConnectedToInternet)
        }
        do {
            let _: Item = try await makeAPI().getJSON("/foo")
            XCTFail("Expected throw")
        } catch let error as EdgeAPIError {
            switch error {
            case .network: break
            default: XCTFail("Expected .network, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Request timeouts (US-992)

    /// The shared bounded session must carry the configured idle/resource
    /// timeouts — not URLSession's 60s default. This is what stops a hung
    /// request from sitting ~60s behind a spinner (then retrying toward ~3min).
    func test_boundedSession_hasConfiguredTimeouts() {
        let config = EdgeNetwork.makeSession().configuration
        XCTAssertEqual(config.timeoutIntervalForRequest, EdgeNetwork.requestTimeout)
        XCTAssertEqual(config.timeoutIntervalForResource, EdgeNetwork.resourceTimeout)
        XCTAssertLessThanOrEqual(EdgeNetwork.requestTimeout, 20, "Idle timeout should be ~15-20s, not the 60s default")
        // The process-wide shared session must be bounded the same way.
        XCTAssertEqual(EdgeNetwork.shared.configuration.timeoutIntervalForRequest, EdgeNetwork.requestTimeout)
    }

    /// A server that never responds must surface as `.network` and return well
    /// within budget (bounded session) instead of hanging ~60s per attempt.
    /// Uses a short per-request timeout so the test itself stays fast; the
    /// transient-retry path runs but the whole call still completes quickly.
    func test_stalledServer_timesOutAsNetworkError_withinBudget() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StallingURLProtocol.self]
        config.timeoutIntervalForRequest = 0.5
        config.timeoutIntervalForResource = 1
        let session = URLSession(configuration: config)
        let api = EdgeAPI(
            baseURL: URL(string: "https://example.test")!,
            session: session,
            tokenProvider: { "tk_test" }
        )

        let start = Date()
        do {
            let _: Item = try await api.getJSON("/slow")
            XCTFail("Expected a timeout, not a successful response")
        } catch let error as EdgeAPIError {
            guard case .network = error else {
                return XCTFail("Timeout should map to .network, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(type(of: error)): \(error)")
        }
        let elapsed = Date().timeIntervalSince(start)
        // An unbounded session would hang ~60s per attempt (×3 with retries).
        // Bounded: 3 attempts @0.5s + backoff (~0.5s + ~1s) ≈ 3s.
        XCTAssertLessThan(elapsed, 20, "Bounded session should fail fast; took \(elapsed)s")
    }

    // MARK: - Response cache bounding (US-995)

    private func cachedItemHandler() -> MockURLProtocol.Handler {
        { request in
            (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"{"id":"x","title":"y","created_at":"2026-01-01T00:00:00Z"}"#.utf8)
            )
        }
    }

    /// Inserting more than the entry cap must not grow the cache past it; the
    /// running byte total must also stay within the byte cap.
    func test_responseCache_boundedByEntryCap_whenOverfilled() async throws {
        MockURLProtocol.handler = cachedItemHandler()
        let api = makeAPI()

        let caps = await api.cacheStatsForTesting()
        let overCap = caps.maxEntries + 25
        for i in 0..<overCap {
            let _: Item = try await api.getJSON("/api/v1/items/\(i)", cacheTTL: 60)
        }

        let stats = await api.cacheStatsForTesting()
        XCTAssertGreaterThan(stats.entries, 0)
        XCTAssertLessThanOrEqual(stats.entries, stats.maxEntries)
        XCTAssertLessThanOrEqual(stats.bytes, stats.maxBytes)
    }

    /// Expired entries are removed on the next insert, not merely skipped on
    /// lookup — so a long-lived session can't leak stale blobs forever.
    func test_responseCache_removesExpiredEntriesOnInsert() async throws {
        MockURLProtocol.handler = cachedItemHandler()
        let api = makeAPI()

        let _: Item = try await api.getJSON("/api/v1/items/stale", cacheTTL: 0.05)
        try await Task.sleep(nanoseconds: 150_000_000) // 0.15s > 0.05s TTL
        let _: Item = try await api.getJSON("/api/v1/items/fresh", cacheTTL: 60)

        let stats = await api.cacheStatsForTesting()
        XCTAssertEqual(stats.entries, 1, "Expired entry should have been purged on the fresh insert")
    }

    // MARK: - Helpers

    /// Reads `httpBodyStream` to a Data buffer. URLProtocol surfaces request
    /// bodies as a stream when the body is set via `URLRequest.httpBody`
    /// after the request hits the protocol.
    private static func readStream(_ request: URLRequest) -> Data? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

// MARK: - Throw helper

/// Calls `EdgeAPI.getJSON` decoded as `Item`, asserts it throws, and that the
/// thrown ``EdgeAPIError`` equals the expected case. Wrapping the generic
/// call here keeps the test bodies tight and sidesteps generic-inference
/// issues from generic closures.
private func XCTAssertThrowsItem(
    _ expected: EdgeAPIError,
    with api: EdgeAPI,
    path: String = "/foo",
    file: StaticString = #file,
    line: UInt = #line
) async {
    do {
        let _: Item = try await api.getJSON(path)
        XCTFail("Expected to throw \(expected), but no error was thrown", file: file, line: line)
    } catch let error as EdgeAPIError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("Expected EdgeAPIError.\(expected), got \(type(of: error)): \(error)", file: file, line: line)
    }
}

/// File-scoped response fixture used by the test bodies and the throw helper.
fileprivate struct Item: Codable, Equatable {
    let id: String
    let title: String
    let createdAt: Date
}

/// Thread-safe call counter for stateful mock handlers (e.g. "429 then 200").
/// The handler runs on URLSession's loading thread; retries are sequential, but
/// the lock keeps it sound under `@unchecked Sendable`.
final class CallBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0
    func next() -> Int { lock.lock(); defer { lock.unlock() }; _count += 1; return _count }
    var count: Int { lock.lock(); defer { lock.unlock() }; return _count }
}

/// Thread-safe recorder for the `Authorization` header observed across the
/// sequential attempts of a single call — lets a refresh test assert the retry
/// carried a DIFFERENT (refreshed) token than the first attempt.
final class AuthBox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String?] = []
    func record(_ value: String?) { lock.lock(); defer { lock.unlock() }; values.append(value) }
    var first: String? { lock.lock(); defer { lock.unlock() }; return values.first ?? nil }
    var last: String? { lock.lock(); defer { lock.unlock() }; return values.last ?? nil }
}

// MARK: - Mock URLProtocol

/// URLSession protocol intercept. Each test sets ``handler`` to a closure
/// that returns the response + body (or throws). Resets in `tearDown`.
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data)
    static var handler: Handler?

    override class func canInit(with request: URLRequest) -> Bool { handler != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

// MARK: - Stalling URLProtocol (US-992)

/// A protocol that never responds promptly — it simulates a hung connection so
/// the session's request timeout is what ends the call. If the timeout fires
/// (the bounded-session behavior we want), the awaiting task fails with
/// `URLError.timedOut` and `stopLoading` cancels the deferred completion. If
/// the timeout did NOT fire, the deferred completion would eventually succeed
/// and the test's "expected throw" assertion would fail — so this can't hang.
final class StallingURLProtocol: URLProtocol, @unchecked Sendable {
    /// Far longer than any test session timeout — long enough that the timeout
    /// always wins, short enough that a broken build fails fast rather than hangs.
    static let stallSeconds: TimeInterval = 6
    private var deferred: DispatchWorkItem?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let response = HTTPURLResponse(
                url: self.request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: Data(#"{"id":"x","title":"y","created_at":"2026-01-01T00:00:00Z"}"#.utf8))
            self.client?.urlProtocolDidFinishLoading(self)
        }
        deferred = item
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.stallSeconds, execute: item)
    }

    override func stopLoading() { deferred?.cancel() }
}
