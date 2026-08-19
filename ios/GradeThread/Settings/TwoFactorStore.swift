import Foundation
import Observation
import Supabase

/// US-2671 — TOTP two-factor enrollment on iOS.
///
/// WHY THIS EXISTS. A workspace member whose owner turned on the 2FA policy is
/// denied on EVERY request (`workspace_mfa_required`, edge
/// `lib/workspace-roles.ts`), and until this shipped the app told them to go
/// enable 2FA on gradethread.com because there was nowhere on-device to send
/// them. A phone-only reseller had no way to unblock themselves.
///
/// THE PART THAT IS EASY TO GET WRONG, and it is why this store has an
/// ``elevate(code:)`` as well as an enrollment flow: the edge does not check
/// whether a factor EXISTS, it checks the session's assurance level. Password
/// sign-in mints an `aal1` token no matter how many verified factors the
/// account has, so enrolling once does not keep the member unblocked — every
/// later cold sign-in lands back on `aal1` and needs one code to reach `aal2`.
/// Enrollment alone would have looked complete and left the member blocked the
/// next morning.
///
/// Enrollment goes client → GoTrue through the Supabase SDK, exactly as the web
/// card does (`src/components/settings/mfa-card.tsx`). Recovery codes are
/// deliberately NOT here: they are minted by the edge (`/api/account/mfa/*`) and
/// shown once, and a set of one-time codes rendered on the device that holds the
/// authenticator is a backup stored beside the thing it backs up. They stay on
/// the web card, and the sheet says so.
@MainActor
@Observable
final class TwoFactorStore {
    /// What the user is looking at. `aal2` is carried on `.enabled` because the
    /// answer to "can this member act in the workspace right now" is the
    /// assurance level, not the presence of a factor.
    enum Phase: Equatable {
        case loading
        /// No verified factor on the account.
        case disabled
        /// A factor was created and is waiting for its first correct code. The
        /// factor exists server-side in `unverified` state from this moment.
        case enrolling(Enrollment)
        /// A verified factor exists. `aal2` says whether THIS session has been
        /// elevated with a code yet.
        case enabled(factorId: String, aal2: Bool)
        case failed(String)
    }

    struct Enrollment: Equatable {
        let factorId: String
        /// Base32 shared secret, for the "enter it manually" path.
        let secret: String
        /// `otpauth://totp/...` — what the QR code encodes.
        let uri: String
    }

    var phase: Phase = .loading
    /// Set alongside a phase that is still usable (a wrong code does not throw
    /// the user out of enrollment), cleared on the next attempt.
    var errorMessage: String?

    private var isBusy = false
    /// True while a network call is in flight, so the sheet can disable its
    /// buttons without owning the state.
    var busy: Bool { isBusy }

    private let issuer = "GradeThread"

    // MARK: - Reads

    func refresh() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        await load()
    }

    /// The read itself, WITHOUT the re-entrancy guard, so the write paths can
    /// re-read while still holding it. Calling `refresh()` from inside one would
    /// hit its own guard and silently no-op, leaving the sheet on the state it
    /// had before the write it just made.
    private func load() async {
        phase = .loading
        errorMessage = nil
        do {
            let factors = try await SupabaseShared.client.auth.mfa.listFactors()
            // Filter `all` rather than trusting `.totp`: the SDK's convenience
            // list is verified-only, and the enrollment cleanup below has to
            // reach UNVERIFIED factors.
            let verified = factors.all.first {
                $0.factorType == "totp" && $0.status == .verified
            }
            guard let verified else {
                phase = .disabled
                return
            }
            let aal = try await SupabaseShared.client.auth.mfa
                .getAuthenticatorAssuranceLevel()
            phase = .enabled(factorId: verified.id, aal2: aal.currentLevel == "aal2")
        } catch {
            phase = .failed(Self.friendlyMessage(for: error, context: "load"))
        }
    }

    // MARK: - Enrollment

    func startEnrollment() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        do {
            try await discardUnverifiedFactors()
            let response = try await SupabaseShared.client.auth.mfa.enroll(
                params: MFATotpEnrollParams(
                    issuer: issuer,
                    friendlyName: Self.friendlyName()
                )
            )
            guard let totp = response.totp else {
                // A TOTP enroll with no TOTP payload is a server-shape change,
                // not a user error — say so rather than showing an empty QR.
                phase = .failed("Two-factor setup isn't available right now. Try again later.")
                return
            }
            phase = .enrolling(
                Enrollment(factorId: response.id, secret: totp.secret, uri: totp.uri)
            )
        } catch {
            errorMessage = Self.friendlyMessage(for: error, context: "enroll")
        }
    }

    /// Verify the first code against a freshly-created factor. On success the
    /// factor becomes `verified` AND this session is elevated to `aal2`, which
    /// is what unblocks a member the workspace policy was denying.
    func confirmEnrollment(code: String) async {
        guard case let .enrolling(enrollment) = phase, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        do {
            try await Self.challengeAndVerify(factorId: enrollment.factorId, code: code)
            HapticFeedback.success()
            await load()
        } catch {
            HapticFeedback.error()
            errorMessage = Self.friendlyMessage(for: error, context: "verify_enroll")
        }
    }

    /// Abandon an in-progress enrollment. The factor is deleted server-side —
    /// leaving it would collide with the next attempt's friendly name and, worse,
    /// leave an account that reads as half-enrolled on the web card.
    func cancelEnrollment() async {
        guard case let .enrolling(enrollment) = phase else { return }
        phase = .loading
        errorMessage = nil
        try? await SupabaseShared.client.auth.mfa.unenroll(
            params: MFAUnenrollParams(factorId: enrollment.factorId)
        )
        await refresh()
    }

    // MARK: - Elevation + removal

    /// Raise THIS session to `aal2` with a current code. Needed after any cold
    /// sign-in for a workspace whose owner requires 2FA, and before removing a
    /// factor (GoTrue refuses an `aal1` unenroll of a verified factor).
    func elevate(code: String) async {
        guard case let .enabled(factorId, _) = phase, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        do {
            try await Self.challengeAndVerify(factorId: factorId, code: code)
            HapticFeedback.success()
            await load()
        } catch {
            HapticFeedback.error()
            errorMessage = Self.friendlyMessage(for: error, context: "verify_elevate")
        }
    }

    func disable() async {
        guard case let .enabled(factorId, _) = phase, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        do {
            try await SupabaseShared.client.auth.mfa.unenroll(
                params: MFAUnenrollParams(factorId: factorId)
            )
            HapticFeedback.success()
            await load()
        } catch {
            HapticFeedback.error()
            errorMessage = Self.friendlyMessage(for: error, context: "unenroll")
        }
    }

    // MARK: - Internals

    /// Remove abandoned unverified factors before enrolling. GoTrue keeps the
    /// row created by an enroll the user walked away from, and a second enroll
    /// with the same friendly name is refused.
    private func discardUnverifiedFactors() async throws {
        let factors = try await SupabaseShared.client.auth.mfa.listFactors()
        for factor in factors.all where factor.factorType == "totp" && factor.status == .unverified {
            try? await SupabaseShared.client.auth.mfa.unenroll(
                params: MFAUnenrollParams(factorId: factor.id)
            )
        }
    }

    /// Device name so a user with several authenticators can tell the factors
    /// apart on the web card. Uniquified with a short timestamp because GoTrue
    /// refuses a duplicate friendly name and two iPhones report the same model.
    private static func friendlyName() -> String {
        let stamp = Int(Date().timeIntervalSince1970) % 100_000
        return "iPhone (\(stamp))"
    }
}

// MARK: - Code entry rules (pure)

/// The keypad rules, kept out of the view and out of the store so they are
/// testable without a session or a SwiftUI host — same split as
/// ``ChangePasswordSheet/validate(newPassword:confirm:)``.
enum TwoFactorCode {
    /// TOTP is always six digits. Authenticator apps display them grouped
    /// ("123 456") and a paste carries the space, so non-digits are dropped
    /// rather than rejected.
    static let length = 6

    static func normalized(_ raw: String) -> String {
        String(raw.filter(\.isNumber).prefix(length))
    }

    static func isComplete(_ raw: String) -> Bool {
        normalized(raw).count == length
    }
}

// MARK: - Challenge → verify, with the IPv6 retry

extension TwoFactorStore {
    /// GoTrue binds each MFA challenge to the IP that CREATED it and rejects the
    /// verify (422 `mfa_ip_address_mismatch`) when the verify egresses from a
    /// different address. On cellular IPv6 — rotating RFC 4941 temporary
    /// addresses, or a Wi-Fi/cellular handoff mid-flow — a single attempt flakes
    /// for a user who typed the right code.
    ///
    /// The server-side fix normalises the client IP at the proxy
    /// (`vault/10-ops/mfa-ipv6-ip-mismatch.md`). This is the client half, and it
    /// is a deliberate port of the web helper (`src/lib/mfa.ts`) rather than a
    /// second design: re-running challenge → verify as one tight unit re-stamps
    /// the challenge IP immediately before the verify, so the retry usually
    /// reuses the just-warmed connection. A WRONG CODE IS NEVER RETRIED.
    static func challengeAndVerify(
        factorId: String,
        code: String,
        retries: Int = 3
    ) async throws {
        let trimmed = TwoFactorCode.normalized(code)
        try await runChallengeVerify(
            code: trimmed,
            retries: retries,
            challenge: {
                let response = try await SupabaseShared.client.auth.mfa.challenge(
                    params: MFAChallengeParams(factorId: factorId)
                )
                return response.id
            },
            verify: { challengeId, entered in
                _ = try await SupabaseShared.client.auth.mfa.verify(
                    params: MFAVerifyParams(
                        factorId: factorId,
                        challengeId: challengeId,
                        code: entered
                    )
                )
            }
        )
    }

    /// The retry policy itself, with both network calls injected so a test can
    /// drive every branch without a GoTrue container. The policy is the part
    /// that can be wrong; the two calls are the part that cannot be tested here.
    ///
    /// `nonisolated` because the store is `@MainActor` and these four helpers are
    /// pure — without it an XCTest method has to hop to the main actor to call a
    /// string comparison, which is the kind of friction that ends with the pure
    /// logic being tested through the view instead.
    nonisolated static func runChallengeVerify(
        code: String,
        retries: Int,
        challenge: () async throws -> String,
        verify: (String, String) async throws -> Void
    ) async throws {
        var lastError: Error?
        for attempt in 0...max(0, retries) {
            let challengeId: String
            do {
                challengeId = try await challenge()
            } catch {
                // A mismatch cannot surface on challenge — it is the call that
                // STAMPS the IP — so any challenge failure is terminal.
                throw error
            }
            do {
                try await verify(challengeId, code)
                return
            } catch {
                lastError = error
                guard isIpMismatch(error) else { throw error }
                if attempt < max(0, retries) {
                    try? await Task.sleep(for: .milliseconds(150))
                }
            }
        }
        if let lastError, isIpMismatch(lastError) {
            throw TwoFactorError.ipMismatch
        }
        throw lastError ?? TwoFactorError.ipMismatch
    }

    /// Matched on the wire vocabulary rather than on a concrete SDK error case:
    /// the code string is GoTrue's and is stable, while the Swift error shape has
    /// changed across SDK minors. A rename upstream degrades this to "no retry",
    /// which is the old behaviour, not a crash.
    nonisolated static func isIpMismatch(_ error: Error) -> Bool {
        if case TwoFactorError.ipMismatch = error { return true }
        let text = describe(error).lowercased()
        if text.contains("mfa_ip_address_mismatch") { return true }
        return text.contains("ip address") && text.contains("mismatch")
    }

    nonisolated static func describe(_ error: Error) -> String {
        let localized = error.localizedDescription
        let raw = String(describing: error)
        return localized == raw ? raw : "\(localized) \(raw)"
    }

    /// User-facing copy. Never GoTrue's raw sentence (US-1025 convention): the
    /// detail goes to Sentry, the user gets something they can act on.
    /// NOT `nonisolated`, unlike its three neighbours: it reports to
    /// ``Telemetry``, which is `@MainActor`. Every caller is a store method
    /// already on the main actor.
    static func friendlyMessage(for error: Error, context: String) -> String {
        let detail = describe(error)
        Telemetry.breadcrumb("2FA \(context) failed: \(detail)", category: "auth")
        Telemetry.event("auth_error", props: ["context": "mfa_\(context)", "detail": detail])
        if isIpMismatch(error) { return TwoFactorError.ipMismatch.message }
        let lowered = detail.lowercased()
        if lowered.contains("invalid totp code") || lowered.contains("invalid_code")
            || lowered.contains("invalid mfa") {
            return "That code didn't match. Check your authenticator app and try the current code."
        }
        if lowered.contains("expired") {
            return "That code expired. Enter the one showing now."
        }
        if lowered.contains("aal2") || lowered.contains("insufficient") {
            return "Enter a current code to confirm it's you, then try again."
        }
        return FriendlyErrorCopy.authMessage(for: error)
    }
}

enum TwoFactorError: Error {
    case ipMismatch

    var message: String {
        switch self {
        case .ipMismatch:
            return "Your connection changed address between asking for the code and confirming it "
                + "(common on cellular IPv6 or a VPN). Try again — if it keeps failing, switch to "
                + "Wi-Fi or turn off your VPN for this step."
        }
    }
}
