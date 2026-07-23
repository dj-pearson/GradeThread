import Foundation

/// Poll/re-validate state machine for an in-flow grade-credit top-up (US-809).
///
/// When a seller is blocked from grading (no included grades left + a zero
/// credit balance) they can buy a credit pack right inside the grading sheet.
/// The grant lands asynchronously — StoreKit confirms the purchase, then
/// `/appstore/verify` calls the idempotent `grant_appstore_credits` RPC — so
/// the user's `grade_credit_balance` lags the purchase by a moment. This
/// machine polls the billing snapshot with bounded retries + exponential
/// backoff until the granted credits appear, then asks the caller to
/// re-validate so the submit button unblocks. On timeout it still re-validates
/// (the grant may have landed between the final poll and now) and leaves the
/// sheet usable with a "Check again" retry affordance.
///
/// It never submits anything — it only unblocks the existing submit button —
/// so there is no double-grant risk here (and the server grant RPC is itself
/// idempotent by transaction id).
///
/// Pure of UI + network: the balance fetch and the sleep are injected, and the
/// re-validate is passed per call, so the whole machine is unit-tested with no
/// Supabase/StoreKit dependency.
@MainActor
@Observable
final class CreditTopUpFlow {

    enum State: Equatable {
        /// No top-up in progress.
        case idle
        /// A purchase succeeded; polling the billing snapshot for the grant.
        case awaitingGrant
        /// The grant landed — the associated value is the new credit balance.
        case granted(Int)
        /// The grant didn't appear within the poll window. The sheet stays
        /// usable; the user can poll again ("Check again").
        case timedOut
    }

    private(set) var state: State = .idle

    /// Current credit balance (server truth), or nil on a transient fetch error.
    private let fetchBalance: () async -> Int?
    /// Injectable sleep (no-op in tests) — receives the backoff delay in nanos.
    private let sleep: (UInt64) async -> Void
    /// Max poll attempts before giving up (exponential backoff capped at ~8s).
    let maxPolls: Int

    init(
        maxPolls: Int = 12,
        fetchBalance: @escaping () async -> Int?,
        sleep: @escaping (UInt64) async -> Void = { try? await Task.sleep(nanoseconds: $0) }
    ) {
        self.maxPolls = maxPolls
        self.fetchBalance = fetchBalance
        self.sleep = sleep
    }

    /// Poll until the credit balance exceeds `baseline` (the grant landed) or
    /// the window elapses, then run `revalidate`. The grant is detected by a
    /// strict increase over the pre-purchase balance, which tolerates transient
    /// nil fetches (a failed poll just retries on the next tick).
    func awaitGrant(baseline: Int, revalidate: () async -> Void) async {
        state = .awaitingGrant
        for attempt in 0..<maxPolls {
            if Task.isCancelled { break }
            if let balance = await fetchBalance(), balance > baseline {
                state = .granted(balance)
                await revalidate()
                return
            }
            // No sleep after the final attempt — we're about to give up.
            if attempt < maxPolls - 1 {
                await sleep(Backoff.jitteredDelayNanos(attempt: attempt, base: 1, cap: 8))
            }
        }
        state = .timedOut
        // The grant may have arrived between the last poll and now; re-validate
        // so the server (source of truth) decides whether submit is unblocked.
        await revalidate()
    }

    /// Return to idle (e.g. when a fresh validation cycle starts).
    func reset() { state = .idle }
}
