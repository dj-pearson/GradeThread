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
}
