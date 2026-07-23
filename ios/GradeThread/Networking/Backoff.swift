import Foundation

/// Exponential-backoff delay helper (US-638). Shared by the grade + eBay
/// pollers and ``EdgeAPI``'s transient-failure retry so we stop hammering the
/// server on fixed-interval loops and back off as a wait drags on.
enum Backoff {
    /// Deterministic ceiling delay (nanoseconds) for a 0-based `attempt`:
    /// `base * 2^attempt`, capped at `cap`. e.g. base 1s → 1, 2, 4, 8 (capped).
    /// This is the UPPER bound of the backoff window — live retry/poll loops
    /// should use ``jitteredDelayNanos(attempt:base:cap:randomFraction:)`` so a
    /// fleet doesn't retry in lockstep. Kept pure + deterministic so the
    /// exponential-growth math stays unit-testable.
    static func delayNanos(attempt: Int, base: TimeInterval = 1, cap: TimeInterval = 8) -> UInt64 {
        let exponent = Double(max(attempt, 0))
        let seconds = min(cap, base * pow(2, exponent))
        return UInt64(max(0, seconds) * 1_000_000_000)
    }

    /// Equal-jitter backoff: half the deterministic ``delayNanos`` plus a random
    /// point in the other half — i.e. a delay uniformly in `[d/2, d]`. This
    /// spreads retries so N clients recovering from a shared edge outage (5xx/429
    /// from the single-container `functions.gradethread.com`) don't re-synchronize
    /// their retries into a lockstep spike (thundering herd) that re-hammers a
    /// server already struggling — while never dropping below half the backoff, so
    /// it still backs off meaningfully. `randomFraction` (clamped to 0...1) is
    /// injectable so tests are deterministic; it defaults to a fresh random per
    /// call (default args are re-evaluated at every call site).
    static func jitteredDelayNanos(
        attempt: Int,
        base: TimeInterval = 1,
        cap: TimeInterval = 8,
        randomFraction: Double = Double.random(in: 0...1)
    ) -> UInt64 {
        let ceiling = delayNanos(attempt: attempt, base: base, cap: cap)
        let half = ceiling / 2
        let frac = min(max(randomFraction, 0), 1)
        return half + UInt64(Double(half) * frac)
    }
}
