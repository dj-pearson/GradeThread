import Foundation

/// US-1517: signature-gated memoization for view-level derivations.
///
/// The US-967 pattern (`@State` value + `.onChange(of: signature, initial:
/// true)`) leaves the first `body` pass reading an empty placeholder; this
/// variant computes lazily on first read instead, so there is never a frame of
/// missing data. Hold an instance in `@State` (one cache per view identity) and
/// read through `value(signature:compute:)` — the closure runs only when the
/// signature differs from the cached one, i.e. once per data change rather than
/// once per row/body pass.
///
/// Mutating this plain (non-`@Observable`) class during `body` evaluation is
/// deliberate and safe: it does not invalidate the view.
@MainActor
final class SignatureCache<Value> {
    private var signature: Int?
    private var cached: Value?

    func value(signature: Int, compute: () -> Value) -> Value {
        if let cached, self.signature == signature { return cached }
        let fresh = compute()
        cached = fresh
        self.signature = signature
        return fresh
    }
}
