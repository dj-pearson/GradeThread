import Foundation

/// US-2818 - the inline AI rewrite the web composer has had since US-552, which
/// iOS never got. The only AI copy iOS could produce was the publish dialog's
/// one-shot `/listing-copy`, so a seller who wanted the description tightened,
/// or rebuilt from the photos, had no move but to retype it.
///
/// One action per call, mirroring `POST /api/flipdesk/ai/rewrite`.
enum ListingRewriteAction: String, CaseIterable, Sendable {
    case titleSeo = "title_seo"
    case titleShorten = "title_shorten"
    case titleKeywords = "title_keywords"
    case descriptionTighten = "description_tighten"
    case descriptionRegen = "description_regen"

    /// Which field the action rewrites. Mirrors the edge `rewriteField`.
    var field: Field {
        rawValue.hasPrefix("title_") ? .title : .description
    }

    enum Field: String, Sendable { case title, description }

    /// Menu copy.
    var label: String {
        switch self {
        case .titleSeo:            return "Punch up for search"
        case .titleShorten:        return "Shorten to 80 characters"
        case .titleKeywords:       return "Add buyer keywords"
        case .descriptionTighten:  return "Tighten & polish"
        case .descriptionRegen:    return "Regenerate from photos"
        }
    }
}

/// The one suggestion a rewrite returns. The endpoint answers in the `/extract`
/// envelope so the web composer can reuse its review panel; only the single
/// entry under `suggestions` matters here.
struct ListingRewriteResult: Equatable, Sendable {
    let field: ListingRewriteAction.Field
    let value: String
    let confidence: Double
}

/// Friendly errors mapped from the endpoint's documented statuses, so the canvas
/// shows something actionable instead of a raw code.
enum ListingRewriteError: LocalizedError, Equatable {
    case itemNotSynced
    case quotaReached
    case unavailable
    case emptySource(String)
    case other(String)

    var errorDescription: String? {
        switch self {
        case .itemNotSynced:
            return "Save and sync this item first, then rewrite its copy."
        case .quotaReached:
            return "You've hit your monthly AI limit. It resets next cycle - or upgrade for a higher cap."
        case .unavailable:
            return "AI rewrite is temporarily unavailable. Try again shortly."
        case .emptySource(let message):
            return message
        case .other(let message):
            return message
        }
    }
}

/// Abstraction so the canvas's rewrite menu is unit-testable with a fake.
@MainActor
protocol ListingRewriting {
    func rewrite(
        itemId: String,
        action: ListingRewriteAction,
        title: String,
        description: String
    ) async throws -> ListingRewriteResult
}

@MainActor
final class ListingRewriteService: ListingRewriting {

    private let baseURL: URL
    private let session: URLSession

    // US-1407: AI inference route, so the generous AI session rather than the
    // short-idle default - a photo regenerate runs a vision model.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.aiSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func rewrite(
        itemId: String,
        action: ListingRewriteAction,
        title: String,
        description: String
    ) async throws -> ListingRewriteResult {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/flipdesk/ai/rewrite"
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = await SupabaseShared.currentAccessToken() {
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        // US-670: the route re-binds every read to the WORKSPACE owner, so a
        // member acting inside a shared workspace 404s on their own item
        // without this. Mirrors EdgeAPI.buildRequest and AutolisterService.
        if let workspaceOwner = WorkspaceScope.activeOwnerId {
            request.setValue(workspaceOwner, forHTTPHeaderField: "X-Workspace-Owner")
        }
        // The GradeThread credentials block is appended server-side and is HTML
        // the model has no business rewriting, so it never goes over the wire -
        // web parity (composer.tsx runRewrite hides it the same way).
        let body = Request(
            itemId: itemId,
            action: action.rawValue,
            title: title,
            description: ListingDescriptionTemplate
                .splitSellerCredentials(description).body
        )
        request.httpBody = try JSONEncoder().encode(body)

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
            throw Self.mapError(status: http.statusCode, body: data)
        }
        return try Self.decode(data, action: action)
    }

    /// Pull the single suggestion out of the `/extract`-shaped envelope.
    /// `nonisolated` so the decode contract is testable without hopping to the
    /// main actor — it touches nothing but its arguments.
    nonisolated static func decode(
        _ data: Data,
        action: ListingRewriteAction
    ) throws -> ListingRewriteResult {
        let envelope: Envelope
        do {
            envelope = try JSONDecoder().decode(Envelope.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
        // Key on the ACTION's field rather than "whatever came back": a
        // description rewrite that arrived under `title` would otherwise be
        // dropped into the wrong box.
        guard let suggestion = envelope.suggestions[action.field.rawValue],
              !suggestion.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw ListingRewriteError.unavailable
        }
        return ListingRewriteResult(
            field: action.field,
            value: suggestion.value,
            confidence: suggestion.confidence ?? 0
        )
    }

    /// 404 (item not found / unsynced), 400 (the source field was empty),
    /// 402 + 429 (quota gate / atomic-reservation exhaustion), 502 (AI down).
    nonisolated private static func mapError(status: Int, body: Data) -> Error {
        let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: body)
        switch status {
        case 404:      return ListingRewriteError.itemNotSynced
        case 402, 429: return ListingRewriteError.quotaReached
        case 502:      return ListingRewriteError.unavailable
        case 400:
            return ListingRewriteError.emptySource(
                parsed?.message ?? "There's nothing to rewrite yet."
            )
        default:
            return ListingRewriteError.other(
                parsed?.message ?? "Couldn't rewrite the copy (HTTP \(status))."
            )
        }
    }

}

// File scope, not nested: global-actor isolation propagates into nested types,
// and the decode above is deliberately `nonisolated` so a test can call it.
private struct Request: Encodable {
    let itemId: String
    let action: String
    let title: String
    let description: String
    enum CodingKeys: String, CodingKey {
        case itemId = "item_id"
        case action, title, description
    }
}

private struct Envelope: Decodable {
    let suggestions: [String: Suggestion]
    struct Suggestion: Decodable {
        let value: String
        let confidence: Double?
    }
}
