import Foundation

/// Calls `POST /api/flipdesk/ai/extract`. Routes through ``EdgeAPI/sendRaw``
/// (US-1164) so it inherits the same transient retry/backoff, one forced 401
/// token-refresh, and `X-Plan-Warning` / 402 plan-gate handling as the rest of
/// the app — but it owns its OWN encoder/decoder because the response's
/// `suggestions` dictionary has field-name keys (`brand`, `size`,
/// `garment_category`) that must be preserved verbatim. EdgeAPI's shared decoder
/// applies snake-to-camel conversion, which would mangle them; `sendRaw` sends
/// the bytes and returns the bytes, leaving codec to the caller.
///
/// Backed by ``EdgeAPI/aiShared`` (the long-idle `EdgeNetwork.aiSession`): the
/// extract does ~20-40s of server-side model work and streams nothing until the
/// JSON lands, so the 20s-idle shared session would kill a request that's
/// actually succeeding — a false "AI couldn't read these photos".
@MainActor
final class AIExtractService {
    private let edge: EdgeAPI

    init(edge: EdgeAPI = .aiShared) {
        self.edge = edge
    }

    func extract(_ request: AIExtractRequest) async throws -> AIExtractResponse {
        // Request body has explicit CodingKeys → keep the encoder bare so we
        // don't apply a strategy that would conflict with the keys we declared.
        let bodyData: Data
        do {
            bodyData = try JSONEncoder().encode(request)
        } catch {
            throw EdgeAPIError.decoding("Encoding extract request failed: \(error.localizedDescription)")
        }

        let data = try await edge.sendRaw(
            method: "POST", path: "/api/flipdesk/ai/extract", bodyData: bodyData)

        // No key-conversion strategy — preserves the field-name keys in
        // `suggestions` and `measurements` exactly as the server emitted.
        do {
            return try JSONDecoder().decode(AIExtractResponse.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}
