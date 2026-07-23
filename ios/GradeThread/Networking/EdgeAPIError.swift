import Foundation

/// Typed errors surfaced by `EdgeAPI`. The UI switches on these to render
/// the right message + recovery action instead of a raw HTTP code.
public enum EdgeAPIError: LocalizedError, Equatable {
    case unauthorized
    /// US-1182: the edge auth middleware rejected the request because the
    /// account's email isn't confirmed (403 `{ code: "email_unverified" }`).
    /// Distinct from `.unauthorized` so the UI shows an actionable "verify your
    /// email" message instead of the misleading "session expired" — and so the
    /// client doesn't burn a pointless token refresh (a fresh token is still
    /// unverified). The classic App Store rejection trip-wire when a demo /
    /// review account signs in via email-password without confirming.
    case emailUnverified
    /// US-1253: a 429 rate-limit. `retryAfter` carries the server's
    /// `Retry-After` hint (seconds) when present so the UI can show a concrete
    /// "try again in Ns" instead of a vague "in a moment". The associated value
    /// has a `nil` default so every existing `.rateLimited` construction / match
    /// site keeps compiling (the multipart + `from(statusCode:)` paths have no
    /// header to read and stay nil).
    case rateLimited(retryAfter: TimeInterval? = nil)
    case notFound(detail: String?)
    /// A generic 403 with no known discriminator — the action is genuinely
    /// forbidden (RLS denial, a permission the plan/role lacks), NOT an expired
    /// session. Distinct from `.unauthorized` so `EdgeAPI` does NOT burn a token
    /// refresh (a fresh token can't grant a permission the user doesn't have) and
    /// the UI shows "you don't have permission" instead of the misleading
    /// "session expired" that invited a needless sign-out.
    case forbidden(detail: String?)
    case badRequest(detail: String?)
    case serverError(detail: String?)
    case decoding(String)
    case network(String)
    /// US-794: the caller's membership in the active (X-Workspace-Owner)
    /// workspace was revoked mid-session. Distinct from `.unauthorized` so the
    /// client can clear the stale scope and recover under the personal tenant.
    case workspaceAccessRevoked
    /// US-1510: the server declared this capability unavailable on the current
    /// eBay connection (501 `{ code: "feature_unavailable" }`) — e.g. send-offer
    /// while the production keyset lacks the sell.negotiation scope. Distinct
    /// from `.serverError` so surfaces can render a calm "not available yet"
    /// state instead of a failure, and skip retries (it can't succeed).
    case featureUnavailable(detail: String?)
    /// US-1510: acting on a best offer that's no longer open (409
    /// `{ code: "offer_not_open" }` — expired, retracted, or answered elsewhere).
    /// Distinct so the inbox can refresh itself instead of showing a raw error.
    case offerNotOpen
    /// US-2152: any status carrying `action: "upgrade"` — a plan or quota wall,
    /// not a transport failure. Mirrors Android `EdgeApiError.UpgradeRequired`
    /// (US-1335).
    ///
    /// It exists because the two statuses the edge uses for it are already
    /// spoken for and BOTH said the wrong thing: the monthly free-Snap cap
    /// returns 429 (mapped to `.rateLimited` — "slow down, try again in a
    /// moment", to a seller who must wait until next month), and AI enrichment
    /// being off returns 403 (mapped to `.unauthorized` — "session expired",
    /// prompting a pointless re-sign-in). The server already writes the correct
    /// sentence; keying on the discriminator lets it through, and (being neither
    /// `.rateLimited` nor transient) it is NOT retried.
    case upgradeRequired(detail: String?, code: String?)

    public var errorDescription: String? {
        switch self {
        case .workspaceAccessRevoked:
            return "You no longer have access to that workspace — switched to your own account."
        case .unauthorized:
            return "Your session expired. Sign in again to continue."
        case .emailUnverified:
            return "Please confirm your email to use this feature. Check your inbox for the verification link we sent when you signed up."
        case .rateLimited(let retryAfter):
            if let retryAfter, retryAfter >= 1 {
                return "You're going a little too fast. Try again in \(Int(retryAfter.rounded(.up)))s."
            }
            return "You're going a little too fast. Try again in a moment."
        case .notFound(let detail):
            return detail ?? "We couldn't find that."
        case .forbidden(let detail):
            return detail ?? "You don't have permission to do that."
        case .badRequest(let detail):
            return detail ?? "Something about that request wasn't right."
        case .serverError(let detail):
            return detail ?? "Something went wrong on our end. Please try again."
        case .decoding(let message):
            return "Unexpected response from server: \(message)"
        case .network(let message):
            return "Network error: \(message)"
        case .featureUnavailable(let detail):
            return detail ?? "This feature isn't available yet."
        case .offerNotOpen:
            return "This offer is no longer available — it may have expired or already been answered."
        case .upgradeRequired(let detail, _):
            // The server's copy names the actual limit and what lifts it, so it
            // beats anything generic we could write here.
            return detail ?? "You've reached a limit on your plan. Upgrade to keep going."
        }
    }

    /// US-2152: whether the UI should offer an upgrade route rather than a
    /// retry. Mirrors Android `EdgeApiError.isUpgradePrompt`.
    public var isUpgradePrompt: Bool {
        if case .upgradeRequired = self { return true }
        return false
    }

    /// JSON error shape used by the edge service: `{ "error": "...", "detail": "...",
    /// "error_code": "..." }`. `error_code` is the machine-readable discriminator
    /// (US-794) used to map specific 4xx responses to typed cases. The auth
    /// middleware uses the shorter `code` key (e.g. `email_unverified`), so we
    /// decode both and treat them interchangeably.
    struct WirePayload: Decodable {
        let error: String?
        let detail: String?
        let error_code: String?
        let code: String?
        /// US-2152: the edge's "this is a plan wall" marker (`action: "upgrade"`).
        let action: String?

        /// The machine-readable discriminator, from whichever key the edge used.
        var discriminator: String? { error_code ?? code }
    }

    /// Maps `(statusCode, body)` to a typed error. The body is best-effort
    /// parsed as a `WirePayload`; if that fails we fall through with the raw
    /// string preview so the UI still has something to show.
    static func from(statusCode: Int, body: Data) -> EdgeAPIError {
        let payload = (try? JSONDecoder().decode(WirePayload.self, from: body))
        let detail = payload?.detail ?? payload?.error ?? bodyPreview(body)
        // US-794: a revoked workspace membership comes back as a 403 with this
        // code — surface it as its own case so the client can drop the stale
        // scope rather than treating it as a session-expired 401/403.
        if statusCode == 403, payload?.discriminator == "workspace_access_revoked" {
            return .workspaceAccessRevoked
        }
        // US-1182: an unconfirmed-email 403 — surface an actionable "verify your
        // email" message instead of "session expired", and (since it's not
        // `.unauthorized`) skip the futile token-refresh + retry.
        if statusCode == 403, payload?.discriminator == "email_unverified" {
            return .emailUnverified
        }
        // US-1510: capability gates. Keyed on the discriminator (not just the
        // status) so the mapping survives a future status tweak on the edge.
        // US-1421: reconnect_required is the same capability gate with an
        // actionable fix — the detail string carries the reconnect copy.
        if payload?.discriminator == "feature_unavailable"
            || payload?.discriminator == "reconnect_required" {
            return .featureUnavailable(detail: detail)
        }
        if payload?.discriminator == "offer_not_open" {
            return .offerNotOpen
        }
        // US-2152: a plan/quota wall. Checked AFTER the specific discriminators
        // above (so a revoked workspace still recovers under the personal
        // tenant) but BEFORE the status switch — which is the whole point: the
        // statuses the edge uses for it (429 snap cap, 403 enrichment-off)
        // already map to errors whose copy actively misleads here.
        if payload?.action == "upgrade" {
            return .upgradeRequired(detail: detail, code: payload?.discriminator)
        }
        switch statusCode {
        case 401:      return .unauthorized
        // A 403 with no known discriminator is a genuine permission denial, not an
        // expired session — don't trigger the refresh + "session expired" path.
        case 403:      return .forbidden(detail: detail)
        case 404:      return .notFound(detail: detail)
        case 429:      return .rateLimited()
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
