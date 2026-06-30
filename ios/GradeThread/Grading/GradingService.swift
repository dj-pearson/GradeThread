import Foundation

/// Calls the FlipDesk → GradeThread grading bridge:
///   1. `POST /api/flipdesk/grading/validate`        → readiness + plan/credits
///   2. `POST /api/flipdesk/grading/submit`          → create submission(s)
///   3. `GET  /api/flipdesk/grading/submissions/:id` → poll status + report
///
/// Self-contained `URLRequest` + Supabase bearer token + `EdgeAPIError`
/// mapping, matching ``CompsService`` / ``SnapService``. Snake_case ↔ camelCase
/// is handled by the encoder/decoder key strategies.
@MainActor
final class GradingService {

    private let baseURL: URL
    private let session: URLSession

    // US-1407: bounded session (was `URLSession.shared` = 60s) for the grading
    // validate/submit/get calls. The submit returns a submission id quickly (the
    // model work is polled separately), so the bounded idle timeout is correct.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - Public

    func validate(
        inventoryItemId: String, tier: GradeTierOption
    ) async throws -> GradingValidateResponse {
        if UITestSupport.mockGrading {
            return try GradingMock.validate(inventoryItemId: inventoryItemId, tier: tier)
        }
        return try await post(
            path: "/api/flipdesk/grading/validate",
            body: GradingRequestBody(inventoryItemId: inventoryItemId, tier: tier)
        )
    }

    func submit(
        inventoryItemId: String, tier: GradeTierOption
    ) async throws -> GradingSubmitResponse {
        if UITestSupport.mockGrading {
            return try GradingMock.submit(inventoryItemId: inventoryItemId, tier: tier)
        }
        return try await post(
            path: "/api/flipdesk/grading/submit",
            body: GradingRequestBody(inventoryItemId: inventoryItemId, tier: tier)
        )
    }

    func status(submissionRef: String) async throws -> GradingStatusResponse {
        if UITestSupport.mockGrading {
            return try GradingMock.status(submissionRef: submissionRef)
        }
        return try await get(path: "/api/flipdesk/grading/submissions/\(submissionRef)")
    }

    // MARK: - Batch (bulk grading)

    func validateBatch(
        itemIds: [String], tier: GradeTierOption
    ) async throws -> GradingValidateResponse {
        try await post(
            path: "/api/flipdesk/grading/validate",
            body: GradingRequestBody(itemIds: itemIds, tier: tier)
        )
    }

    func submitBatch(
        itemIds: [String], tier: GradeTierOption
    ) async throws -> GradingSubmitResponse {
        try await post(
            path: "/api/flipdesk/grading/submit",
            body: GradingRequestBody(itemIds: itemIds, tier: tier)
        )
    }

    // MARK: - Internals

    private func post<Body: Encodable, Response: Decodable>(
        path: String, body: Body
    ) async throws -> Response {
        var request = try makeRequest(path: path, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        do {
            request.httpBody = try encoder.encode(body)
        } catch {
            throw EdgeAPIError.decoding("Encoding request failed: \(error.localizedDescription)")
        }
        return try await send(request)
    }

    private func get<Response: Decodable>(path: String) async throws -> Response {
        let request = try makeRequest(path: path, method: "GET")
        return try await send(request)
    }

    private func makeRequest(path: String, method: String) throws -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = path
        guard let url = components?.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        var request = request
        if let token = await SupabaseShared.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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
            throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}
