import Foundation
import Observation

/// US-2503 slice 2: reads the buyer entitlement payload the edge resolves, and
/// answers "is this capability unlocked for this account".
///
/// The four AC2 screens gate on this. It is deliberately the only place in the
/// app that decides that question, because the second place is where the two
/// clients start to disagree.
@MainActor
@Observable
final class BuyerEntitlementsStore {

    /// Always a usable value. Before the first load, and after any failure, that
    /// value is the locked floor — never nil, so no caller has to invent a
    /// default and no caller can accidentally invent an unlocked one.
    private(set) var entitlements: BuyerEntitlements = .free

    /// True when the last load did not complete. Distinct from "on the free
    /// plan": a paying buyer whose request timed out sees a retry, not a
    /// silent downgrade that reads as a billing problem.
    private(set) var loadFailed = false

    private(set) var isLoading = false

    private let fetch: () async throws -> BuyerEntitlements

    /// The default resolves in the BODY rather than in a default argument value,
    /// because a default argument cannot reference a private member.
    init(fetch: (() async throws -> BuyerEntitlements)? = nil) {
        self.fetch = fetch ?? { try await Self.loadEntitlements() }
    }

    func load() async {
        if isLoading { return }
        isLoading = true
        defer { isLoading = false }
        do {
            entitlements = try await fetch()
            loadFailed = false
        } catch {
            // Deliberately does NOT keep a previously-loaded unlocked value on a
            // later failure. A stale unlock is the one state this store must
            // never serve: it is indistinguishable from a real entitlement and
            // it survives until the app is relaunched.
            entitlements = .free
            loadFailed = true
        }
    }

    /// Whether a capability is unlocked AND has an iOS surface to unlock into.
    ///
    /// Both halves matter and they fail differently. A capability the plan does
    /// not include is a paywall. A capability iOS does not deliver is not a
    /// paywall at all — telling a paying subscriber to upgrade for something
    /// their plan already includes is worse than telling them where it lives.
    func isUsable(_ capability: BuyerCapability) -> Bool {
        capability.delivery == .shipped && entitlements.isUnlocked(capability)
    }

    /// Whether the plan includes it, regardless of where it runs. This is what
    /// the plan screen lists.
    func isIncluded(_ capability: BuyerCapability) -> Bool {
        entitlements.isUnlocked(capability)
    }

    private static func loadEntitlements() async throws -> BuyerEntitlements {
        try await EdgeAPI.shared.getJSON("/api/buyer/entitlements")
    }
}
