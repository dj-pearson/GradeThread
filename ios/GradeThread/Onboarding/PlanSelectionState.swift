import Foundation

/// US-804: gates the one-time, post-signup plan-selection step so a freshly
/// created account is offered a subscription/credit pack exactly once, while an
/// existing signed-in user is never re-prompted.
///
/// The challenge is distinguishing a *fresh* account from an existing one without
/// a server round-trip. We solve it in two hops:
///
///   1. A device-level `pending` flag is set the moment a signup succeeds
///      (email/password ``AuthStore/signUp`` or a first-time Apple grant). It
///      carries no user id because, with email confirmation on, the account
///      isn't signed in yet.
///   2. The first time the app reaches a signed-in state, `resolvePending`
///      attaches that pending flag to the now-known user id (`eligible`) and
///      clears it. An existing user who simply signs in has no pending flag, so
///      they never become eligible.
///
/// `shouldOffer` is then `eligible && !offered`; `markOffered` records that the
/// step was shown (purchased or skipped) so it runs once and only once. All of
/// this is pure UserDefaults bookkeeping with an injectable suite, so the
/// show-once logic is unit-tested in isolation (``PlanSelectionStateTests``).
///
/// Keys are versioned (`.v1`) so a future redesign can re-introduce the step to
/// existing users by bumping the suffix.
struct PlanSelectionState {
    static let pendingKey = "com.gradethread.app.planSelection.pending.v1"
    static let eligibleKey = "com.gradethread.app.planSelection.eligible.v1"
    static let offeredKey = "com.gradethread.app.planSelection.offered.v1"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - Stored sets

    private func ids(_ key: String) -> [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    private func append(_ id: String, to key: String) {
        var values = ids(key)
        guard !values.contains(id) else { return }
        values.append(id)
        defaults.set(values, forKey: key)
    }

    private func remove(_ id: String, from key: String) {
        let values = ids(key).filter { $0 != id }
        defaults.set(values, forKey: key)
    }

    // MARK: - Signup → eligibility

    /// Whether a signup completed on this device but hasn't yet been attached to
    /// a signed-in user id.
    var hasPendingEligibility: Bool {
        defaults.bool(forKey: Self.pendingKey)
    }

    /// Record that a fresh account was just created (no id available yet because
    /// email confirmation may not have signed the user in). Resolved to a concrete
    /// user id by ``resolvePending(userId:)``.
    func markPendingEligibility() {
        defaults.set(true, forKey: Self.pendingKey)
    }

    /// Attach a pending signup to the now-known user id and clear the flag. No-op
    /// when there's no pending signup (e.g. an existing user signing in) or the
    /// user has already been offered the step. Idempotent.
    func resolvePending(userId: UUID) {
        guard hasPendingEligibility else { return }
        defaults.set(false, forKey: Self.pendingKey)
        let id = userId.uuidString
        guard !ids(Self.offeredKey).contains(id) else { return }
        append(id, to: Self.eligibleKey)
    }

    // MARK: - Offer gating

    /// True once and only once for a fresh, eligible account that hasn't already
    /// been shown the step.
    func shouldOffer(userId: UUID) -> Bool {
        let id = userId.uuidString
        return ids(Self.eligibleKey).contains(id) && !ids(Self.offeredKey).contains(id)
    }

    /// Whether the plan step has already been shown to this account.
    func hasOffered(userId: UUID) -> Bool {
        ids(Self.offeredKey).contains(userId.uuidString)
    }

    /// Record that the plan step was shown (purchased or skipped) so it never
    /// re-prompts. Drops the id from `eligible` so the set doesn't grow.
    func markOffered(userId: UUID) {
        let id = userId.uuidString
        append(id, to: Self.offeredKey)
        remove(id, from: Self.eligibleKey)
    }
}
