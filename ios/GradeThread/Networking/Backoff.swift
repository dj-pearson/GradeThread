import Foundation

/// Exponential-backoff delay helper (US-638). Shared by the grade + eBay
/// pollers and ``EdgeAPI``'s transient-failure retry so we stop hammering the
/// server on fixed-interval loops and back off as a wait drags on.
enum Backoff {
    /// Delay (nanoseconds) for a 0-based `attempt`: `base * 2^attempt`, capped
    /// at `cap`. e.g. base 1s → 1, 2, 4, 8 (capped).
    static func delayNanos(attempt: Int, base: TimeInterval = 1, cap: TimeInterval = 8) -> UInt64 {
        let exponent = Double(max(attempt, 0))
        let seconds = min(cap, base * pow(2, exponent))
        return UInt64(max(0, seconds) * 1_000_000_000)
    }
}
