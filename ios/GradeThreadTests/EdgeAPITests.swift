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

    private func makeAPI(token: String? = "tk_test") -> EdgeAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        return EdgeAPI(
            baseURL: URL(string: "https://example.test")!,
            session: session,
            tokenProvider: { token }
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
        await XCTAssertThrowsItem(.rateLimited, with: makeAPI())
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
