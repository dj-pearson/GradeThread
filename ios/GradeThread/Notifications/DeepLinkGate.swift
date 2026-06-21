import Foundation

/// Rate-limits inbound deep links so a flood of `com.gradethread.app://` URLs
/// (any installed app can open a custom scheme) can't spawn unbounded work or
/// ANR the app (US-1156). Pure + static so it's trivially unit-testable.
enum DeepLinkGate {
    /// Minimum spacing between accepted inbound deep links. Real taps (widget,
    /// push, auth callback) never arrive faster than this; a spam burst does.
    static let minInterval: TimeInterval = 0.25

    /// Whether an inbound link at `now` should be accepted given the last one's
    /// timestamp. The first link (`last == nil`) is always accepted.
    static func shouldAccept(
        last: Date?, now: Date = .now, minInterval: TimeInterval = minInterval
    ) -> Bool {
        guard let last else { return true }
        return now.timeIntervalSince(last) >= minInterval
    }
}

/// Holds the most-recent deep link that arrived before the app finished signing
/// in, so it routes once auth completes instead of being silently dropped
/// (US-1156). Single-slot on purpose: only the latest intent matters.
struct PendingDeepLink {
    private(set) var route: DeepLinkRoute?

    /// Stash a route to replay after sign-in. A newer route supersedes an older
    /// queued one.
    mutating func queue(_ route: DeepLinkRoute) { self.route = route }

    /// Returns and clears the queued route, if any.
    mutating func take() -> DeepLinkRoute? {
        defer { route = nil }
        return route
    }
}
