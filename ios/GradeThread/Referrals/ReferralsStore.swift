import SwiftUI

/// View-model for the Referrals screen. Loads the user's code + stats, builds the
/// shareable signup link, and redeems a friend's code. Pattern mirrors the other
/// @MainActor @Observable stores.
@MainActor
@Observable
final class ReferralsStore {

    enum Phase: Equatable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    private let service: ReferralProviding

    var phase: Phase = .idle
    var me: ReferralMe?
    var redeemCode = ""
    var isRedeeming = false
    var redeemError: String?
    var redeemSucceeded = false

    init(service: ReferralProviding = ReferralService()) {
        self.service = service
    }

    // MARK: - Derived

    /// Shareable signup link, e.g. https://gradethread.com/signup?ref=ABCD2345.
    /// Reuses the existing site-origin constant rather than hardcoding.
    var referralURL: URL? {
        guard let code = me?.code, !code.isEmpty else { return nil }
        return URL(string: "\(CertificateLink.siteOrigin.absoluteString)/signup?ref=\(code)")
    }

    /// People referred who are awaiting qualification or the reward grant.
    var inProgress: Int { (me?.stats.pending ?? 0) + (me?.stats.qualified ?? 0) }

    var alreadyReferred: Bool { me?.referredBy != nil }

    var canRedeem: Bool {
        !alreadyReferred && !isRedeeming && !redeemCode.trimmed.isEmpty
    }

    // MARK: - Actions

    func load() async {
        phase = .loading
        do {
            me = try await service.me()
            phase = .ready
        } catch {
            phase = .failed(message(error))
        }
    }

    /// Attribute the caller as referred by `redeemCode`. On success, reloads so
    /// the "you were referred" state reflects immediately. Returns success.
    @discardableResult
    func redeem() async -> Bool {
        let code = redeemCode.trimmed.uppercased()
        guard !code.isEmpty, !alreadyReferred else { return false }
        isRedeeming = true
        redeemError = nil
        defer { isRedeeming = false }
        do {
            let res = try await service.redeem(code: code)
            guard res.ok else { return false }
            redeemSucceeded = true
            redeemCode = ""
            await load()
            return true
        } catch {
            redeemError = message(error)
            return false
        }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
