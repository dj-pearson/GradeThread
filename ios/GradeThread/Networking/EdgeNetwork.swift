import Foundation

/// Shared, bounded `URLSession` for edge-service and Supabase-storage traffic
/// (US-992). `URLSession.shared` defaults to a 60s per-request timeout — on
/// flaky cellular a stalled request hangs ~60s behind a spinner, and the
/// transient-retry path (``EdgeAPI``) then doubles it toward ~3min. A bounded
/// *idle* timeout fails fast as `URLError.timedOut`, which maps to
/// ``EdgeAPIError/network`` and is treated as transient by the retry path.
enum EdgeNetwork {
    /// Idle / per-request timeout: if a connection stalls with no new data for
    /// this long it fails as `URLError.timedOut`. Kept short (vs. the 60s
    /// default) so a hung request surfaces or retries promptly.
    static let requestTimeout: TimeInterval = 20

    /// Overall ceiling for a single resource load. A slow-but-progressing
    /// upload/download (e.g. a photo on weak cellular) isn't killed at
    /// ``requestTimeout``, but it still can't run unbounded.
    static let resourceTimeout: TimeInterval = 60

    /// Builds a `URLSession` with the bounded timeouts above. Use this instead
    /// of `URLSession.shared` for all edge / storage traffic.
    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = requestTimeout
        config.timeoutIntervalForResource = resourceTimeout
        return URLSession(configuration: config)
    }

    /// Process-wide bounded session so callers don't each spin up their own
    /// (every `URLSession` owns a connection pool).
    static let shared: URLSession = makeSession()

    /// Idle timeout for AI INFERENCE calls (`/ai/extract`, `/ai/size`, snap).
    /// These are fundamentally different from a normal request: the server does
    /// 20-60s of model work and streams NOTHING back until the JSON is ready, so
    /// the connection sits legitimately IDLE the entire time. The 20s
    /// ``requestTimeout`` therefore killed a 38s extract that had actually
    /// SUCCEEDED server-side — the app showed "AI couldn't read these photos"
    /// while the good result was already on its way. One-call extract also runs
    /// an eBay-aspects SECOND model pass, which routinely pushes the happy path
    /// to ~40s, so this ceiling is deliberately generous.
    static let aiRequestTimeout: TimeInterval = 120

    /// Idle timeout for MARKETPLACE ORCHESTRATION (eBay publish / revise / end /
    /// relist).
    ///
    /// Same shape as an AI call and for a different reason: the edge makes
    /// SEVERAL eBay API calls in sequence — a Taxonomy suggestion, a category
    /// aspect fetch, create-inventory-item, create-offer, publish-offer — and
    /// returns nothing until the last one lands, so the connection sits idle
    /// throughout. The server bounds each of those hops at 20 seconds
    /// (`EBAY_TIMEOUT_MS`) and retries transient failures up to three times, so
    /// ONE slow hop can consume more than the whole 20s ``requestTimeout`` the
    /// short session allows. The client was giving up inside a window the server
    /// is explicitly designed to survive.
    ///
    /// Which matters more here than elsewhere, because **publish is not
    /// idempotent** — the edge says so itself (US-528: a 5xx/timeout can land
    /// after eBay has already created the listing). A client-side timeout that
    /// the seller answers by tapping again is how one item becomes two live
    /// listings. See ``EbayPublishService/networkFailureMessage(_:verb:)`` for
    /// the other half of that: a timeout must not be reported as "offline, try
    /// again".
    ///
    /// Not set to cover the true worst case, which is unbounded: three retries
    /// across five hops, each with its own backoff, cannot be waited out and
    /// should not be. Past this ceiling a publish has almost certainly hit a
    /// retry storm, and the honest answer is to stop waiting and tell the seller
    /// to check eBay.
    static let marketplaceRequestTimeout: TimeInterval = 90

    /// Overall ceiling for one marketplace orchestration call.
    static let marketplaceResourceTimeout: TimeInterval = 150

    /// Dedicated session for eBay lifecycle calls (see
    /// ``marketplaceRequestTimeout``).
    static let marketplaceSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = marketplaceRequestTimeout
        config.timeoutIntervalForResource = marketplaceResourceTimeout
        return URLSession(configuration: config)
    }()

    /// Dedicated session for slow AI-inference POSTs (see ``aiRequestTimeout``).
    /// Both the idle and the overall-resource ceilings are raised: the call
    /// makes no incremental progress to reset an idle timer, so a short idle
    /// timeout is exactly wrong here.
    static let aiSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = aiRequestTimeout
        config.timeoutIntervalForResource = aiRequestTimeout
        return URLSession(configuration: config)
    }()
}
