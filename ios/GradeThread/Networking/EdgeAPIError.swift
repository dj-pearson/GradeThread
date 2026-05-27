import Foundation

/// Typed errors surfaced by `EdgeAPI`. The UI switches on these to render
/// the right message + recovery action instead of a raw HTTP code.
public enum EdgeAPIError: LocalizedError, Equatable {
    case unauthorized
    case rateLimited
    case notFound(detail: String?)
    case badRequest(detail: String?)
    case serverError(detail: String?)
    case decoding(String)
    case network(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Your session expired. Sign in again to continue."
        case .rateLimited:
            return "You're going a little too fast. Try again in a moment."
        case .notFound(let detail):
            return detail ?? "We couldn't find that."
        case .badRequest(let detail):
            return detail ?? "Something about that request wasn't right."
        case .serverError(let detail):
            return detail ?? "Something went wrong on our end. Please try again."
        case .decoding(let message):
            return "Unexpected response from server: \(message)"
        case .network(let message):
            return "Network error: \(message)"
        }
    }

    /// JSON error shape used by the edge service: `{ "error": "...", "detail": "..." }`.
    struct WirePayload: Decodable {
        let error: String?
        let detail: String?
    }

    /// Maps `(statusCode, body)` to a typed error. The body is best-effort
    /// parsed as a `WirePayload`; if that fails we fall through with the raw
    /// string preview so the UI still has something to show.
    static func from(statusCode: Int, body: Data) -> EdgeAPIError {
        let payload = (try? JSONDecoder().decode(WirePayload.self, from: body))
        let detail = payload?.detail ?? payload?.error ?? bodyPreview(body)
        switch statusCode {
        case 401, 403: return .unauthorized
        case 404:      return .notFound(detail: detail)
        case 429:      return .rateLimited
        case 400...499: return .badRequest(detail: detail)
        case 500...599: return .serverError(detail: detail)
        default:        return .serverError(detail: detail)
        }
    }

    private static func bodyPreview(_ data: Data) -> String? {
        guard !data.isEmpty,
              let text = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return nil }
        // Cap so we don't surface a 50KB stack trace in a toast.
        return text.count > 240 ? String(text.prefix(240)) + "…" : text
    }
}
